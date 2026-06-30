// Vercel Serverless Function
// GET /api/news?q=<player name>&club=<club name>(optional)&offset=<n>    -> list (fast, no AI)
// GET /api/news?topics=1&offset=<n>                                      -> homepage feed: national team + match results focused
// GET /api/news?summarize=1&title=<...>&desc=<...>&playerName=<...>      -> single AI summary (on demand)

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

// Known squad with surname-only and full-name variants for robust post-hoc correction.
// Each entry maps WRONG/PARTIAL kanji variants -> the single correct kanji form.
const NAME_CORRECTIONS = [
  { correct: '鈴木彩艶', surname: '鈴木', variants: ['鈴木彩艶', '鈴木彩炎', '鈴木彩園'] },
  { correct: '大迫敬介', surname: '大迫', variants: ['大迫敬介', '大迫敬助'] },
  { correct: '早川友基', surname: '早川', variants: ['早川友基', '早川友紀'] },
  { correct: '菅原由勢', surname: '菅原', variants: ['菅原由勢', '菅原由世', '菅原祐勢'] },
  { correct: '谷口彰悟', surname: '谷口', variants: ['谷口彰悟', '谷口翔悟'] },
  { correct: '板倉滉', surname: '板倉', variants: ['板倉滉', '板倉浩', '板倉宏'] },
  { correct: '長友佑都', surname: '長友', variants: ['長友佑都', '長友祐都', '長友有都'] },
  { correct: '渡辺剛', surname: '渡辺', variants: ['渡辺剛', '渡邊剛', '渡辺豪'] },
  { correct: '伊藤洋輝', surname: '伊藤', variants: ['伊藤洋輝', '伊東洋輝'] },
  { correct: '冨安健洋', surname: '冨安', variants: ['冨安健洋', '富安健洋'] },
  { correct: '瀬古歩夢', surname: '瀬古', variants: ['瀬古歩夢', '瀬古歩武'] },
  { correct: '鈴木淳之介', surname: '鈴木', variants: ['鈴木淳之介', '鈴木純之介'] },
  { correct: '遠藤航', surname: '遠藤', variants: ['遠藤航', '遠藤行'] },
  { correct: '伊東純也', surname: '伊東', variants: ['伊東純也', '伊藤純也'] },
  { correct: '鎌田大地', surname: '鎌田', variants: ['鎌田大地', '鎌田大智'] },
  { correct: '堂安律', surname: '堂安', variants: ['堂安律', '堂安立'] },
  { correct: '田中碧', surname: '田中', variants: ['田中碧', '田中緑'] },
  { correct: '町野修斗', surname: '町野', variants: ['町野修斗', '町野修人'] },
  { correct: '中村敬斗', surname: '中村', variants: ['中村敬斗', '中村敬人', '中村啓斗', '中村啓人', '中村敬登', '中村慶斗'] },
  { correct: '佐野海舟', surname: '佐野', variants: ['佐野海舟', '佐野海周'] },
  { correct: '久保建英', surname: '久保', variants: ['久保建英', '久保健英'] },
  { correct: '鈴木唯人', surname: '鈴木', variants: ['鈴木唯人', '鈴木惟人'] },
  { correct: '塩貝健人', surname: '塩貝', variants: ['塩貝健人', '塩貝建人'] },
  { correct: '小川航基', surname: '小川', variants: ['小川航基', '小川航己'] },
  { correct: '前田大然', surname: '前田', variants: ['前田大然', '前田大善'] },
  { correct: '上田綺世', surname: '上田', variants: ['上田綺世', '上田奇世', '上田希世'] },
  { correct: '後藤啓介', surname: '後藤', variants: ['後藤啓介', '後藤敬介'] },
  { correct: '松木玖生', surname: '松木', variants: ['松木玖生', '松木久生'] },
  { correct: '高井幸大', surname: '高井', variants: ['高井幸大', '高井幸太'] },
  { correct: '細谷真大', surname: '細谷', variants: ['細谷真大', '細谷真太'] },
  { correct: '藤田譜人', surname: '藤田', variants: ['藤田譜人', '藤田譜仁'] },
];

// Post-process AI output: replace any wrong-variant spelling with the correct kanji.
function fixPlayerNames(text) {
  if (!text) return text;
  let fixed = text;
  for (const entry of NAME_CORRECTIONS) {
    for (const variant of entry.variants) {
      if (variant === entry.correct) continue;
      fixed = fixed.split(variant).join(entry.correct);
    }
  }
  return fixed;
}

const SQUAD_NAMES = NAME_CORRECTIONS.map(e => e.correct).join('、');

async function summarizeOne(title, desc, playerName) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return null;

  let prompt = `以下はサッカー関連の英語ニュースです。日本語で4〜6文程度のしっかりした要約を作成してください。見出しから読み取れる文脈（背景、選手の状況、試合結果やパフォーマンス、今後の展望など）を可能な限り具体的に補って書いてください。情報が少ない場合は、わかる範囲で丁寧に膨らませてください。\n\n重要：選手名の漢字表記は必ず正確に書いてください。日本代表の正しい選手名表記一覧: ${SQUAD_NAMES}。`;
  if (playerName) {
    prompt += `\nこのニュースの主役は「${playerName}」です。要約内でこの選手名を書く際は、必ず「${playerName}」という正確な表記を一字一句そのまま使ってください。`;
  }
  prompt += `\n\n出力は要約文のみ、前置きや説明は不要です。\n\n見出し: ${title}\n詳細: ${desc || '(なし)'}`;

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
    if (!text) return null;
    // Always run the deterministic name-fix pass regardless of what the model produced
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

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
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
    // Even the fallback translation should get the name-fix pass
    const fallback = fixPlayerNames(await translateText(desc || title));
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
        pageItems.map(it => translateText(it.title).then(fixPlayerNames).catch(() => it.title))
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
      pageItems.map(it => translateText(it.title).then(fixPlayerNames).catch(() => it.title))
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
