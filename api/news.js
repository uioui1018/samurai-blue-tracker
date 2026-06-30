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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'missing query' });
  }

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' football')}&hl=en-US&gl=US&ceid=US:en`;
    const rssRes = await fetch(rssUrl);
    const xml = await rssRes.text();

    const items = [];
    const itemBlocks = xml.split('<item>').slice(1).slice(0, 6);
    for (const block of itemBlocks) {
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
      const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (cleanTitle) {
        items.push({ title: cleanTitle, link: link.trim(), pubDate, source: source.trim() });
      }
    }

    if (items.length === 0) {
      return res.status(200).json({ items: [] });
    }

    const translated = await Promise.all(items.map(it => translateText(it.title)));

    const now = Date.now();
    const result = items.map((it, i) => {
      let time = '';
      if (it.pubDate) {
        const diffSec = Math.floor((now - new Date(it.pubDate).getTime()) / 1000);
        if (diffSec < 3600) time = `${Math.max(1, Math.floor(diffSec / 60))}分前`;
        else if (diffSec < 86400) time = `${Math.floor(diffSec / 3600)}時間前`;
        else time = `${Math.floor(diffSec / 86400)}日前`;
      }
      return {
        title_ja: translated[i] || it.title,
        title_en: it.title,
        link: it.link,
        source: it.source,
        time,
      };
    });

    res.status(200).json({ items: result });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: String(err) });
  }
}
