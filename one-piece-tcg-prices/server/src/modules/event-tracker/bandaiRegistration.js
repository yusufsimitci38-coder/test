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
const { isEnglishSpeaking } = require('./regionClassifier');

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

function stripTagsToPlainText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strips tags/scripts/styles down to plain visible text, in reading order,
// but first wraps heading text (<h1>-<h6>) in an inline @@REGION@@ marker so
// section context (e.g. a "USA & Canada" heading grouping several months'
// registration dates) survives being flattened - extraction otherwise
// wouldn't depend on whether content sits in a <table>, list, or paragraph,
// only on the words themselves, which also means it doesn't know what
// region a given date belongs to without this.
function htmlToStructuredText(html) {
  let working = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');

  working = working.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner) => {
    const plain = stripTagsToPlainText(inner);
    return plain ? ` @@REGION@@${plain}@@/REGION@@ ` : ' ';
  });

  return stripTagsToPlainText(working);
}

const DATE_WINDOW_RE = /for\s+([a-z]+)\s+events?[:\s]+(?:starts?\s+)?([a-z]+\s+\d{1,2},?\s*\d{4})/gi;

// Matches "For August Events: May 24, 2026" and "For March Events: Starts
// December 28, 2025" style phrasing - both forms turned up when researching
// this page's actual content. Splits on the @@REGION@@ markers so each match
// gets tagged with whichever heading most recently preceded it (null if none
// has appeared yet).
function extractRegistrationWindows(structuredText, seasonLabel, sourceUrl) {
  const windows = [];
  const parts = structuredText.split(/@@REGION@@(.*?)@@\/REGION@@/);

  let currentRegion = null;
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) {
      currentRegion = parts[i].trim() || null;
      continue;
    }

    DATE_WINDOW_RE.lastIndex = 0;
    let match = DATE_WINDOW_RE.exec(parts[i]);
    while (match) {
      windows.push({
        eventMonth: match[1],
        applicationOpensOn: match[2].replace(/\s+/g, ' '),
        location: currentRegion,
        isEnglishSpeaking: isEnglishSpeaking(currentRegion),
        season: seasonLabel,
        sourceUrl,
      });
      match = DATE_WINDOW_RE.exec(parts[i]);
    }
  }
  return windows;
}

async function fetchRegistrationWindows() {
  const windows = [];
  for (const page of SEASON_PAGES) {
    try {
      const text = htmlToStructuredText(await fetchHtml(page.url));
      windows.push(...extractRegistrationWindows(text, page.label, page.url));
    } catch (err) {
      console.warn(`[bandai] couldn't fetch ${page.label} (${err.message})`);
    }
  }
  return windows;
}

// Diagnostic only: raw plain text pulled from each season page (truncated),
// used by GET /api/event-tracker/debug/bandai-raw to check the real page
// content (including any @@REGION@@ markers actually found) against what
// extractRegistrationWindows expects.
async function fetchRawText() {
  const results = [];
  for (const page of SEASON_PAGES) {
    try {
      const html = await fetchHtml(page.url);
      const text = htmlToStructuredText(html);
      results.push({
        label: page.label,
        url: page.url,
        ok: true,
        textLength: text.length,
        textSample: text.slice(0, 4000),
        regionsFound: [...text.matchAll(/@@REGION@@(.*?)@@\/REGION@@/g)].map((m) => m[1].trim()),
        extracted: extractRegistrationWindows(text, page.label, page.url),
      });
    } catch (err) {
      results.push({ label: page.label, url: page.url, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { fetchRegistrationWindows, fetchRawText };
