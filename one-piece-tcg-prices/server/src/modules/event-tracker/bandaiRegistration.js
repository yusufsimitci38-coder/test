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
// Confirmed against real page content (via the debug endpoint below, run
// against the live deployment - this sandbox can't reach the site itself):
// under "Event Schedule and Tournament Organizer", each region (North
// America / Europe / Oceania / Latin America) lists its own Regionals as
// "<Organizer> Date: <range> Venue: <address> Link: <registration URL>" -
// giving exact venue and a direct registration link per event, not just a
// month bucket. A separate "Application Period" section gives the date each
// month's registration opens ("For March Events: Starts December 28, 2025")
// plus a guideline time-of-day per region ("North America: 9:00am PT /
// 12:00pm ET") - explicitly flagged on the page itself as a guideline only,
// since the exact time is set by each third-party tournament organizer.
// extractRegionalEvents()/extractApplicationPeriodInfo() encode this shape;
// fetchRawText() still exists to re-verify if Bandai's page changes again.

const { version } = require('../../../package.json');
const { isEnglishSpeaking } = require('./regionClassifier');

const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const EVENTS_INDEX_URL = 'https://en.onepiece-cardgame.com/events/';

// Static fallback, used only if discovering season pages from the events
// index (below) fails outright - e.g. the site is unreachable, or its
// markup changes enough to break the discovery regex too. Left pointing at
// the season(s) known at the time this was written; kept in sync manually
// as a last resort, since discoverSeasonPages() is the primary path and
// picks up new seasons (e.g. 27-28) automatically without a code change.
const FALLBACK_SEASON_PAGES = [
  { label: 'Regional Season 1 (26-27)', url: 'https://en.onepiece-cardgame.com/events/regional-season1-26-27.html' },
  { label: 'Regional Season 2 (26-27)', url: 'https://en.onepiece-cardgame.com/events/regional-season2-26-27.html' },
];

const SEASON_PAGE_HREF_RE = /href="([^"]*\/events\/(regional-season(\d+)-(\d{2})-(\d{2})\.html))"/gi;

// Scrapes the site's own events index page for links matching the Regional
// season-page URL pattern (e.g. "regional-season1-26-27.html"), so a new
// season (27-28, 28-29, ...) is picked up automatically the next time it's
// linked from that page, instead of needing this file edited every year.
async function discoverSeasonPages() {
  const html = await fetchHtml(EVENTS_INDEX_URL);
  const found = new Map();

  SEASON_PAGE_HREF_RE.lastIndex = 0;
  let m = SEASON_PAGE_HREF_RE.exec(html);
  while (m) {
    const [, href, slug, seasonNum, startYr, endYr] = m;
    const url = new URL(href, EVENTS_INDEX_URL).toString();
    if (!found.has(url)) {
      found.set(url, { label: `Regional Season ${seasonNum} (${startYr}-${endYr})`, url });
    }
    m = SEASON_PAGE_HREF_RE.exec(html);
  }

  return [...found.values()];
}

async function getSeasonPages() {
  try {
    const discovered = await discoverSeasonPages();
    if (discovered.length) return discovered;
    console.warn('[bandai] events index page had no regional-season links, falling back to hardcoded list');
  } catch (err) {
    console.warn(`[bandai] couldn't discover season pages from events index (${err.message}), falling back to hardcoded list`);
  }
  return FALLBACK_SEASON_PAGES;
}

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

// Wraps heading text (<h1>-<h6>) in an inline @@REGION@@ marker and link
// targets in @@LINK:href@@...@@/LINK@@, before stripping all other tags to
// plain text - so section context and registration URLs both survive being
// flattened to a single text blob for regex extraction.
function htmlToStructuredText(html) {
  let working = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');

  working = working.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner) => {
    const plain = stripTagsToPlainText(inner);
    return plain ? ` @@REGION@@${plain}@@/REGION@@ ` : ' ';
  });

  working = working.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const plain = stripTagsToPlainText(inner);
    return ` @@LINK:${href}@@${plain}@@/LINK@@ `;
  });

  return stripTagsToPlainText(working);
}

// Debug-only variant: also marks table row/cell boundaries, for eyeballing
// page structure that htmlToStructuredText's plain-text flattening hides.
function htmlToDebugText(html) {
  let working = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');

  working = working.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner) => {
    const plain = stripTagsToPlainText(inner);
    return plain ? ` @@REGION@@${plain}@@/REGION@@ ` : ' ';
  });

  working = working.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const plain = stripTagsToPlainText(inner);
    return ` @@LINK:${href}@@${plain}@@/LINK@@ `;
  });

  working = working.replace(/<tr[^>]*>/gi, ' @@ROW@@ ');
  working = working.replace(/<t[dh][^>]*>/gi, ' @@CELL@@ ');

  return stripTagsToPlainText(working);
}

// Extracts the text between two @@REGION@@ heading markers (by heading
// text), so schedule/application-period parsing can be scoped to the right
// section instead of matching similarly-worded text elsewhere on the page
// (e.g. a Treasure Cup side-event schedule further down).
function sliceSection(text, startHeading, endHeading) {
  const startRe = new RegExp(`@@REGION@@${startHeading}@@/REGION@@`);
  const startMatch = text.match(startRe);
  if (!startMatch) return '';
  const rest = text.slice(startMatch.index + startMatch[0].length);
  if (!endHeading) return rest;
  const endMatch = rest.match(new RegExp(`@@REGION@@${endHeading}@@/REGION@@`));
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

const KNOWN_REGIONS = ['North America', 'Europe', 'Oceania', 'Latin America'];

// Captures the whole "Venue: ..." (or label-less) blob between the date and
// "Link:" as one group, rather than requiring an inline optional "Venue:"
// match immediately after the date - real-page evidence showed the literal
// "Venue:" label sometimes not immediately adjacent to the date (cause
// unconfirmed, since this sandbox can't fetch the raw HTML directly), which
// made the old inline-optional-group version inconsistently fail to strip
// it. Stripping the label as post-processing (see stripVenueLabel) is
// robust to that regardless of the underlying cause.
const EVENT_ENTRY_RE =
  /^\s*Date:\s*([A-Za-z]+\s+\d{1,2}(?:-\d{1,2})?,?\s*\d{4})\s*(.*?)\s*Link:\s*@@LINK:([^@]+)@@/;

function stripVenueLabel(text) {
  return text.trim().replace(/^Venue:\s*/i, '').trim();
}

// Parses the "Event Schedule and Tournament Organizer" section: each
// organizer heading immediately followed by "Date: ... [Venue: ...] Link:
// ..." is one Regional; headings that match a known region name instead
// update which region subsequent entries belong to.
function extractRegionalEvents(scheduleText, monthToOpenDate, timeGuideline, seasonLabel, sourceUrl) {
  const events = [];
  const parts = scheduleText.split(/@@REGION@@(.*?)@@\/REGION@@/);

  let currentRegion = null;
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim();
    const following = parts[i + 1] || '';
    const match = following.match(EVENT_ENTRY_RE);

    if (match) {
      const [, eventDate, rawVenue, registrationUrl] = match;
      const venue = stripVenueLabel(rawVenue);
      const monthMatch = eventDate.match(/^[A-Za-z]+/);
      const monthKey = monthMatch ? monthMatch[0].toLowerCase() : null;
      events.push({
        organizer: heading,
        region: currentRegion,
        eventDate: eventDate.replace(/\s+/g, ' ').trim(),
        venue: venue || null,
        registrationOpensOn: (monthKey && monthToOpenDate[monthKey]) || null,
        registrationOpensTimeGuideline: (currentRegion && timeGuideline[currentRegion]) || null,
        registrationUrl: registrationUrl || null,
        // Deliberately venue-only, not currentRegion - "Latin America" and
        // "North America" both contain the substring "america", which would
        // otherwise false-positive-match the English-speaking marker list
        // before the venue's actual country (e.g. Mexico) is ever checked.
        isEnglishSpeaking: isEnglishSpeaking(venue || heading),
        season: seasonLabel,
        sourceUrl,
      });
    } else if (KNOWN_REGIONS.includes(heading)) {
      currentRegion = heading;
    }
  }
  return events;
}

const MONTH_OPEN_RE = /for\s+([a-z]+)\s+events?[:\s]+(?:starts?\s+)?([a-z]+\s+\d{1,2},?\s*\d{4})/gi;
const TIME_GUIDELINE_RE =
  /(North America|Europe|Oceania|Latin America):\s*(.+?)(?=\s*(?:North America|Europe|Oceania|Latin America):|$)/g;

// Parses the "Application Period" section: which date each month's
// registration opens, plus Bandai's own "guideline only, may vary by
// organizer" time-of-day per region.
function extractApplicationPeriodInfo(applicationText) {
  const monthToOpenDate = {};
  MONTH_OPEN_RE.lastIndex = 0;
  let m = MONTH_OPEN_RE.exec(applicationText);
  while (m) {
    monthToOpenDate[m[1].toLowerCase()] = m[2].replace(/\s+/g, ' ').trim();
    m = MONTH_OPEN_RE.exec(applicationText);
  }

  const timeGuideline = {};
  TIME_GUIDELINE_RE.lastIndex = 0;
  let t = TIME_GUIDELINE_RE.exec(applicationText);
  while (t) {
    timeGuideline[t[1]] = t[2].trim();
    t = TIME_GUIDELINE_RE.exec(applicationText);
  }

  return { monthToOpenDate, timeGuideline };
}

async function fetchRegistrationWindows() {
  const events = [];
  const pages = await getSeasonPages();
  for (const page of pages) {
    try {
      const text = htmlToStructuredText(await fetchHtml(page.url));
      const scheduleText = sliceSection(text, 'Event Schedule and Tournament Organizer', 'Advanced Application Method');
      const applicationText = sliceSection(text, 'Application Period', 'Prize');
      const { monthToOpenDate, timeGuideline } = extractApplicationPeriodInfo(applicationText);
      events.push(...extractRegionalEvents(scheduleText, monthToOpenDate, timeGuideline, page.label, page.url));
    } catch (err) {
      console.warn(`[bandai] couldn't fetch ${page.label} (${err.message})`);
    }
  }
  return events;
}

// Diagnostic only: raw plain text pulled from each season page (truncated),
// used by GET /api/event-tracker/debug/bandai-raw to check the real page
// content against what extractRegionalEvents/extractApplicationPeriodInfo
// expect. debugSample additionally marks table row/cell boundaries
// (@@ROW@@/@@CELL@@) for a human to eyeball the real structure.
async function fetchRawText() {
  const results = [];
  let discoveryError = null;
  let discoveredPages = [];
  try {
    discoveredPages = await discoverSeasonPages();
  } catch (err) {
    discoveryError = err.message;
  }
  results.push({
    label: '(season page discovery)',
    discoveredPages,
    discoveryError,
    usingFallback: discoveredPages.length === 0,
    fallbackPages: discoveredPages.length === 0 ? FALLBACK_SEASON_PAGES : undefined,
  });

  const pages = discoveredPages.length ? discoveredPages : FALLBACK_SEASON_PAGES;
  for (const page of pages) {
    try {
      const html = await fetchHtml(page.url);
      const text = htmlToStructuredText(html);
      const debugText = htmlToDebugText(html);
      const scheduleText = sliceSection(text, 'Event Schedule and Tournament Organizer', 'Advanced Application Method');
      const applicationText = sliceSection(text, 'Application Period', 'Prize');
      const { monthToOpenDate, timeGuideline } = extractApplicationPeriodInfo(applicationText);
      results.push({
        label: page.label,
        url: page.url,
        ok: true,
        textLength: text.length,
        textSample: text.slice(0, 4000),
        regionsFound: [...text.matchAll(/@@REGION@@(.*?)@@\/REGION@@/g)].map((m) => m[1].trim()),
        extracted: extractRegionalEvents(scheduleText, monthToOpenDate, timeGuideline, page.label, page.url),
        debugSampleLength: debugText.length,
        debugSample: debugText.slice(0, 20000),
      });
    } catch (err) {
      results.push({ label: page.label, url: page.url, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  fetchRegistrationWindows,
  fetchRawText,
  // exported for testing against real-page evidence directly, without a
  // network fetch - see scratchpad test scripts from the session that
  // validated this extraction logic
  sliceSection,
  extractRegionalEvents,
  extractApplicationPeriodInfo,
  discoverSeasonPages,
};
