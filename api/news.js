// Vercel Serverless Function
// GET /api/news?q=<player name>&club=<club name>(optional)              -> list (fast, no AI)
// GET /api/news?summarize=1&title=<...>&desc=<...>                       -> single AI summary (on demand)

function stripHtml(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

async function translateText(text) {
  if (!text) return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) return text;
    const data = await res.json();
    return data[0].map(chunk => chunk[0]).join('');
  } catch {
    return text;
  }
}

async function summarizeOne(title, desc) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return null;
  const prompt = `以下はサッカー関連の英語ニュースです。日本語で4〜6文程度のしっかりした要約を作成してください。見出しから読み取れる文脈（背景、選手の状況、試合結果やパフォーマンス、今後の展望など）を可能な限り具体的に補って書いてください。情報が少ない場合は、わかる範囲で丁寧に膨らませてください。出力は要約文のみ、前置きや説明は不要です。\n\n見出し: ${title}\n詳細: ${desc || '(なし)'}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).map(c => c.text || '').join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

function formatTime(pubDate) {
  if (!pubDate) return '';
  const parsed = Date.parse(pubDate);
  if (isNaN(parsed)) return '';
  const diffSec = Math.floor((Date.now() - parsed) / 1000);
  if (diffSec < 0) return 'たった今';
  if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))}分前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}時間前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}日前`;
  return new Date(parsed).toLocaleDateString('ja-JP');
}

async function fetchAndParse(query) {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) return [];
    const xml = await rssRes.text();
    const items = [];
    const itemBlocks = xml.split('<item>').slice(1).slice(0, 15);
    for (const block of itemBlocks) {
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
      const descRaw = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
      const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const cleanDesc = stripHtml(descRaw.replace(/<!\[CDATA\[|\]\]>/g, ''));
      const parsedDate = pubDate ? Date.parse(pubDate.trim()) : NaN;
      if (cleanTitle && !isNaN(parsedDate)) {
        items.push({ title: cleanTitle, desc: cleanDesc, link: link.trim(), pubDate: pubDate.trim(), parsedDate, source: source.trim() });
      }
    }
    return items;
  } catch {
    return [];
  }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.query.summarize === '1') {
    const { title, desc } = req.query;
    if (!title) return res.status(400).json({ error: 'missing title' });
    const summary = await summarizeOne(title, desc || '');
    if (summary) {
      return res.status(200).json({ summary_ja: summary });
    }
    const fallback = await translateText(desc || title);
    return res.status(200).json({ summary_ja: fallback, fallback: true });
  }

  const { q, club } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'missing query' });
  }

  try {
    const queries = [
      `"${q}" football`,
      club ? `"${q}" "${club}"` : `${q} soccer news`,
      `${q} Japan national team`,
    ];

    const resultsArrays = await Promise.all(queries.map(fetchAndParse));
    let combined = dedupe(resultsArrays.flat());
    combined.sort((a, b) => b.parsedDate - a.parsedDate);
    const topItems = combined.slice(0, 6);

    if (topItems.length === 0) {
      return res.status(200).json({ items: [] });
    }

    const translatedTitles = await Promise.all(
      topItems.map(it => translateText(it.title).catch(() => it.title))
    );

    const result = topItems.map((it, i) => ({
      title_ja: translatedTitles[i] || it.title,
      title_en: it.title,
      desc_en: it.desc || '',
      link: it.link,
      source: it.source,
      time: formatTime(it.pubDate),
    }));

    res.status(200).json({ items: result });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: String(err && err.message || err) });
  }
}
