// Vercel Serverless Function
// GET /api/news?q=<player name>&club=<club name>(optional)&offset=<n>    -> list (fast, no AI)
// GET /api/news?topics=1&offset=<n>                                      -> homepage feed: national team + match results focused
// GET /api/news?summarize=1&title=<...>&desc=<...>&playerName=<...>      -> single AI summary (on demand)

function stripHtml(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

// Known squad with common mistranslation variants for translated TITLES.
// Google Translate sometimes invents wrong kanji for player names; this list
// catches the variants we've observed and forces them back to the correct form.
const NAME_FIXES = [
  { correct: '鈴木彩艶', variants: ['鈴木彩世', '鈴木彩園', '鈴木彩炎'] },
  { correct: '大迫敬介', variants: ['大迫敬助'] },
  { correct: '早川友基', variants: ['早川友紀'] },
  { correct: '菅原由勢', variants: ['菅原由世', '菅原祐勢'] },
  { correct: '谷口彰悟', variants: ['谷口翔悟'] },
  { correct: '板倉滉', variants: ['板倉浩', '板倉宏'] },
  { correct: '長友佑都', variants: ['長友祐都', '長友有都'] },
  { correct: '渡辺剛', variants: ['渡邊剛', '渡辺豪'] },
  { correct: '伊藤洋輝', variants: ['伊東洋輝'] },
  { correct: '冨安健洋', variants: ['富安健洋'] },
  { correct: '瀬古歩夢', variants: ['瀬古歩武'] },
  { correct: '鈴木淳之介', variants: ['鈴木純之介'] },
  { correct: '遠藤航', variants: ['遠藤行'] },
  { correct: '伊東純也', variants: ['伊藤純也'] },
  { correct: '鎌田大地', variants: ['鎌田大智'] },
  { correct: '堂安律', variants: ['堂安立'] },
  { correct: '田中碧', variants: ['田中緑'] },
  { correct: '町野修斗', variants: ['町野修人'] },
  { correct: '中村敬斗', variants: ['中村敬人', '中村啓斗', '中村啓人', '中村敬登', '中村慶斗'] },
  { correct: '佐野海舟', variants: ['佐野海周'] },
  { correct: '久保建英', variants: ['久保健英'] },
  { correct: '鈴木唯人', variants: ['鈴木惟人'] },
  { correct: '塩貝健人', variants: ['塩貝建人'] },
  { correct: '小川航基', variants: ['小川航己'] },
  { correct: '前田大然', variants: ['前田大善'] },
  { correct: '上田綺世', variants: ['上田彩世', '上田奇世', '上田希世'] },
  { correct: '後藤啓介', variants: ['後藤敬介'] },
  { correct: '松木玖生', variants: ['松木久生'] },
  { correct: '高井幸大', variants: ['高井幸太'] },
  { correct: '細谷真大', variants: ['細谷真太'] },
  { correct: '藤田譜人', variants: ['藤田譜仁'] },
];

function fixPlayerNames(text) {
  if (!text) return text;
  let fixed = text;
  for (const entry of NAME_FIXES) {
    for (const variant of entry.variants) {
      // also handle the spaced form ("上田 彩世") that sometimes appears
      const spaced = variant.length >= 2 ? variant[0] + ' ' + variant.slice(1) : null;
      fixed = fixed.split(variant).join(entry.correct);
      if (spaced) {
        const correctSpaced = entry.correct[0] + ' ' + entry.correct.slice(1);
        fixed = fixed.split(spaced).join(correctSpaced);
      }
    }
  }
  return fixed;
}

async function translateText(text) {
  if (!text) return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) return text;
    const data = await res.json();
    const translated = data[0].map(chunk => chunk[0]).join('');
    return fixPlayerNames(translated);
  } catch {
    return text;
  }
}

async function summarizeOne(title, desc, playerName) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return null;

  // Strategy: have the model write the summary using a safe placeholder token
  // instead of attempting to spell the player's kanji name itself. We then
  // deterministically substitute the placeholder with the verified correct name.
  const PLACEHOLDER = '《選手》';

  let prompt = `以下はサッカー関連の英語ニュースです。日本語で4〜6文程度のしっかりした要約を作成してください。見出しから読み取れる文脈（背景、選手の状況、試合結果やパフォーマンス、今後の展望など）を可能な限り具体的に補って書いてください。情報が少ない場合は、わかる範囲で丁寧に膨らませてください。\n\n出力は要約文のみ、前置きや説明は不要です。`;

  if (playerName) {
    prompt += `\n\n重要な指示：この記事の主役選手の名前を要約文中で書く必要がある箇所では、絶対に漢字や名前を自分で書かず、必ず代わりに固定の記号「${PLACEHOLDER}」をそのまま使ってください（例：「${PLACEHOLDER}は決勝点を決めた」）。これは後で自動的に正しい名前に変換されるための仕組みです。選手名のフルネーム・姓・名のいずれも直接書いてはいけません。`;
  }

  prompt += `\n\n見出し: ${title}\n詳細: ${desc || '(なし)'}`;

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
    let text = (data.content || []).map(c => c.text || '').join('').trim();
    if (!text) return null;

    if (playerName) {
      text = text.split(PLACEHOLDER).join(playerName);
    }
    // Also run the deterministic fix pass in case the model slipped and wrote a name anyway
    return fixPlayerNames(text);
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
    const itemBlocks = xml.split('<item>').slice(1).slice(0, 30);
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

// Spam/junk filter: remove piracy livestream ads and low-quality sources
const SPAM_SOURCES = ['keith prowse', 'keithprowse'];
const SPAM_TITLE_PATTERNS = [
  /\[?tonton langsung\]?/i,
  /\[?uzivo\]?/i,
  /\[?livestream\]?/i,
  /\[?live stream\]?/i,
  /\[?4k\s*uzivo\]?/i,
  /besplatno sad/i,
  /livefree/i,
  /!!?\$\+/,
  /\+\+\[/,
  /!\$\+\[/,
];

function isSpam(item) {
  const srcLower = (item.source || '').toLowerCase();
  if (SPAM_SOURCES.some(s => srcLower.includes(s))) return true;
  if (SPAM_TITLE_PATTERNS.some(p => p.test(item.title))) return true;
  return false;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    if (isSpam(it)) return false;
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const PAGE_SIZE = 6;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const offset = parseInt(req.query.offset, 10) || 0;

  if (req.query.summarize === '1') {
    const { title, desc, playerName } = req.query;
    if (!title) return res.status(400).json({ error: 'missing title' });
    const summary = await summarizeOne(title, desc || '', playerName || '');
    if (summary) {
      return res.status(200).json({ summary_ja: summary });
    }
    const fallback = await translateText(desc || title);
    return res.status(200).json({ summary_ja: fallback, fallback: true });
  }

  // Homepage topics mode: focused on match results / national team headlines, sorted strictly by recency
  if (req.query.topics === '1') {
    try {
      const queries = [
        'Japan national team football',
        'SAMURAI BLUE football',
        'Japan World Cup 2026 football',
      ];
      const resultsArrays = await Promise.all(queries.map(fetchAndParse));
      let combined = dedupe(resultsArrays.flat());
      combined.sort((a, b) => b.parsedDate - a.parsedDate);
      const pageItems = combined.slice(offset, offset + PAGE_SIZE);
      const hasMore = combined.length > offset + PAGE_SIZE;

      if (pageItems.length === 0) return res.status(200).json({ items: [], hasMore: false });

      const translatedTitles = await Promise.all(
        pageItems.map(it => translateText(it.title).catch(() => it.title))
      );

      const result = pageItems.map((it, i) => ({
        title_ja: translatedTitles[i] || it.title,
        title_en: it.title,
        desc_en: it.desc || '',
        link: it.link,
        source: it.source,
        time: formatTime(it.pubDate),
      }));
      return res.status(200).json({ items: result, hasMore });
    } catch (err) {
      return res.status(500).json({ error: 'fetch_failed', message: String(err && err.message || err) });
    }
  }

  // Per-player mode
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
    const pageItems = combined.slice(offset, offset + PAGE_SIZE);
    const hasMore = combined.length > offset + PAGE_SIZE;

    if (pageItems.length === 0) {
      return res.status(200).json({ items: [], hasMore: false });
    }

    const translatedTitles = await Promise.all(
      pageItems.map(it => translateText(it.title).catch(() => it.title))
    );

    const result = pageItems.map((it, i) => ({
      title_ja: translatedTitles[i] || it.title,
      title_en: it.title,
      desc_en: it.desc || '',
      link: it.link,
      source: it.source,
      time: formatTime(it.pubDate),
    }));

    res.status(200).json({ items: result, hasMore });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: String(err && err.message || err) });
  }
}
