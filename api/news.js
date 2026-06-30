// Vercel Serverless Function
// GET /api/news?q=<search query>
// No API keys required - uses Google News RSS + Google Translate's free endpoint

async function translateText(text) {
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
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const rssRes = await fetch(rssUrl);
  const xml = await rssRes.text();
  const items = [];
  const itemBlocks = xml.split('<item>').slice(1).slice(0, 10);
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const parsedDate = pubDate ? Date.parse(pubDate.trim()) : NaN;
    if (cleanTitle && !isNaN(parsedDate)) {
      items.push({ title: cleanTitle, link: link.trim(), pubDate: pubDate.trim(), parsedDate, source: source.trim() });
    }
  }
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'missing query' });
  }

  try {
    const [clubItems, ntItems] = await Promise.all([
      fetchAndParse(q),
      fetchAndParse(q + ' Japan national team'),
    ]);

    let combined = dedupe([...ntItems, ...clubItems]);
    combined.sort((a, b) => b.parsedDate - a.parsedDate);
    const topItems = combined.slice(0, 8);

    if (topItems.length === 0) {
      return res.status(200).json({ items: [] });
    }

    const translated = await Promise.all(topItems.map(it => translateText(it.title)));

    const result = topItems.map((it, i) => ({
      title_ja: translated[i] || it.title,
      title_en: it.title,
      link: it.link,
      source: it.source,
      time: formatTime(it.pubDate),
    }));

    res.status(200).json({ items: result });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: String(err) });
  }
}
