// Vercel Serverless Function
// GET /api/news?q=<player name>&club=<club name>(optional)
// Uses Google News RSS + Google Translate (free) + Hugging Face (free) for summarization

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

async function summarizeText(text) {
  const HF_TOKEN = process.env.HF_API_TOKEN;
  if (!HF_TOKEN || !text || text.length < 40) return null;
  try {
    const res = await fetch(
      'https://api-inference.huggingface.co/models/facebook/bart-large-cnn',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: text, parameters: { max_length: 60, min_length: 15 } }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data[0] && data[0].summary_text) {
      return data[0].summary_text;
    }
    return null;
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
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const rssRes = await fetch(rssUrl);
  const xml = await rssRes.text();
  const items =
