// Best-effort scraper for en.onepiece-cardgame.com's regional-season pages.
//
// There is no public API for this - confirmed by checking third-party
// sources first (RK9, TopDeck.gg, gumgum.gg, OPlayTCG all lack one; a paid
// wrapper called Parse.bot exists specifically because Bandai's own site
// "does not publish a public developer API or documented data feed").
// Scraping Bandai's own page is the only way to get official registration
// windows at all - each event's own page (from the event tracker's normal
// data) still isn't enough, since only Bandai publishes this schedule.
//
// This is inherently more fragile than a JSON API: extractRegistrationWindows
// is a first-pass guess at the page's text shape (informed by a search
// engine's paraphrase of the real page, not a verified fetch of it - this
// sandbox can't reach the site either). fetchRawText() exists specifically
// so the real extracted text can be checked and this regex corrected against
// real evidence, the same way the price/event provider field guesses were.

const { version } = require('../../../package.json');

const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const SEASON_PAGES = [
  { label: 'Regional Season 1 (26-27)', url: 'https://en.onepiece-cardgame.com/events/regional-season1-26-27.html' },
  { label: 'Regional Season 2 (26-27)', url: 'https://en.onepiece-cardgame.com/events/regional-season2-26-27.html' },
];

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) {
      throw new Error(`${url} -> HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Strips tags/scripts/styles down to plain visible text, in reading order,
// so extraction doesn't depend on whether content sits in a <table>, list,
// or paragraph - only on the words themselves.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRegistrationWindows(text, seasonLabel, sourceUrl) {
  const windows = [];
  // Matches "For August Events: May 24, 2026" and "For March Events: Starts
  // December 28, 2025" style phrasing - both forms turned up when
  // researching this page's actual content.
  const re = /for\s+([a-z]+)\s+events?[:\s]+(?:starts?\s+)?([a-z]+\s+\d{1,2},?\s*\d{4})/gi;
  let match = re.exec(text);
  while (match) {
    windows.push({
      eventMonth: match[1],
      applicationOpensOn: match[2].replace(/\s+/g, ' '),
      season: seasonLabel,
      sourceUrl,
    });
    match = re.exec(text);
  }
  return windows;
}

async function fetchRegistrationWindows() {
  const windows = [];
  for (const page of SEASON_PAGES) {
    try {
      const text = htmlToText(await fetchHtml(page.url));
      windows.push(...extractRegistrationWindows(text, page.label, page.url));
    } catch (err) {
      console.warn(`[bandai] couldn't fetch ${page.label} (${err.message})`);
    }
  }
  return windows;
}

// Diagnostic only: raw plain text pulled from each season page (truncated),
// used by GET /api/event-tracker/debug/bandai-raw to check the real page
// content against what extractRegistrationWindows expects.
async function fetchRawText() {
  const results = [];
  for (const page of SEASON_PAGES) {
    try {
      const html = await fetchHtml(page.url);
      const text = htmlToText(html);
      results.push({
        label: page.label,
        url: page.url,
        ok: true,
        textLength: text.length,
        textSample: text.slice(0, 4000),
        extracted: extractRegistrationWindows(text, page.label, page.url),
      });
    } catch (err) {
      results.push({ label: page.label, url: page.url, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { fetchRegistrationWindows, fetchRawText };
