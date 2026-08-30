// Real event provider, backed by https://play.limitlesstcg.com/api - a
// free, documented tournament database that includes One Piece Card Game
// events (game=OP): Regionals, Treasure Cups, online events, etc. No API
// key is required for the basic /tournaments endpoint.
//
// It does NOT carry registration/"application open" dates - only the event
// itself (name, date, format, organizer, player count, and best-effort
// venue/location - see fetchTournamentDetails). Each event's `url` links
// back to its page on Limitless, which is the place to find registration
// details for that specific event.

const { version } = require('../../../../package.json');
const { isEnglishSpeaking } = require('../regionClassifier');

const BASE = 'https://play.limitlesstcg.com/api';
const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const GAME = 'OP';
const PAGE_SIZE = 100;
const MAX_PAGES = 6; // generous cap (up to 600 tournaments) against runaway pagination
const MAX_DETAIL_FETCHES = 200; // bound how long a refresh can take enriching venues
const DETAIL_PACING_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`${BASE}${path} -> HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEvent(raw) {
  if (!raw || raw.id == null) return null;
  return {
    id: String(raw.id),
    name: raw.name || 'Untitled event',
    date: raw.date || null,
    format: raw.format || null,
    organizer: raw.organizer || null,
    players: typeof raw.players === 'number' ? raw.players : null,
    location: null, // filled in best-effort by enrichWithLocations, if the details endpoint guess works
    isEnglishSpeaking: true, // recomputed once location is known; see fetchEvents
    url: `https://play.limitlesstcg.com/tournament/${raw.id}/details`,
  };
}

// Paginates through one listing path (e.g. "/tournaments" or
// "/tournaments/upcoming") until a short page signals the end.
async function fetchAllPages(basePath) {
  const events = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchJson(`${basePath}?game=${GAME}&limit=${PAGE_SIZE}&page=${page}`);
    const list = Array.isArray(batch) ? batch : Array.isArray(batch?.tournaments) ? batch.tournaments : [];
    if (!list.length) break;
    events.push(...list.map(normalizeEvent).filter(Boolean));
    if (list.length < PAGE_SIZE) break; // reached the last page
  }
  return events;
}

// The basic list doesn't carry venue/location, only a separate per-tournament
// details lookup does (per Limitless's own docs). The exact path isn't
// confirmed from this environment, so two plausible REST shapes are tried
// in order and whichever responds first is used for every subsequent call.
const DETAIL_PATH_CANDIDATES = [(id) => `/tournaments/${id}`, (id) => `/tournaments/${id}/details`];
let workingDetailPath = null;

function extractLocationField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = ['location', 'venue', 'address', 'city'];
  for (const key of candidates) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // Some APIs nest this under a venue/location object with its own city/country.
  for (const key of ['venue', 'location']) {
    const nested = raw[key];
    if (nested && typeof nested === 'object') {
      const parts = [nested.name, nested.city, nested.state, nested.country].filter(
        (v) => typeof v === 'string' && v.trim()
      );
      if (parts.length) return parts.join(', ');
    }
  }
  return null;
}

async function fetchTournamentDetails(id) {
  const pathsToTry = workingDetailPath ? [workingDetailPath] : DETAIL_PATH_CANDIDATES;
  for (const pathFn of pathsToTry) {
    try {
      const raw = await fetchJson(pathFn(id));
      workingDetailPath = pathFn;
      return raw;
    } catch (err) {
      if (pathFn === pathsToTry[pathsToTry.length - 1]) throw err;
    }
  }
  return null;
}

// Best-effort, capped and paced: attaches `location` to as many events as
// MAX_DETAIL_FETCHES allows. A failure on any single event (or on the whole
// endpoint guess) just leaves location null for it - never fails the refresh.
async function enrichWithLocations(events) {
  const toEnrich = events.slice(0, MAX_DETAIL_FETCHES);
  let failures = 0;
  for (const [index, event] of toEnrich.entries()) {
    if (index > 0) await sleep(DETAIL_PACING_MS);
    try {
      const details = await fetchTournamentDetails(event.id);
      event.location = extractLocationField(details);
    } catch (err) {
      failures += 1;
      if (failures === 1) {
        console.warn(`[limitless] couldn't fetch tournament details (${err.message}); locations will be missing`);
      }
      if (failures > 5) {
        console.warn('[limitless] giving up on location enrichment after repeated failures');
        break;
      }
    }
  }
}

async function fetchEvents() {
  // The plain listing appears biased toward already-*held* tournaments
  // (Limitless is fundamentally a results database - its webhooks fire
  // "when a tournament ends", not when one opens for registration), so a
  // forward-looking calendar also needs the site's separate "upcoming"
  // listing, mirroring the distinct /tournaments/upcoming page on the
  // website itself. Merged by id so a calendar month works whether you're
  // looking at the past or the future.
  const merged = new Map();
  for (const e of await fetchAllPages('/tournaments')) merged.set(e.id, e);

  try {
    for (const e of await fetchAllPages('/tournaments/upcoming')) merged.set(e.id, e);
  } catch (err) {
    // Best-effort: if this path guess turns out wrong, don't take down the
    // whole refresh over it - past events from the call above still work.
    console.warn(`[limitless] couldn't fetch upcoming tournaments (${err.message}); showing past events only`);
  }

  const events = [...merged.values()];
  await enrichWithLocations(events);
  for (const event of events) {
    event.isEnglishSpeaking = isEnglishSpeaking(`${event.name} ${event.location || ''}`);
  }
  return events;
}

// Diagnostic only (not part of the shared provider contract): raw,
// untransformed sample from both listing paths plus a details lookup on the
// first tournament found, for checking the real field shape (including
// venue/location) and confirming which endpoint guesses actually work -
// used by GET /api/event-tracker/debug/sample.
async function fetchSampleRaw() {
  const [plain, upcoming] = await Promise.allSettled([
    fetchJson(`/tournaments?game=${GAME}&limit=3`),
    fetchJson(`/tournaments/upcoming?game=${GAME}&limit=3`),
  ]);
  const describe = (result) =>
    result.status === 'fulfilled' ? { ok: true, raw: result.value } : { ok: false, error: result.reason.message };

  const plainResult = describe(plain);
  let details = { attempted: false };
  const sampleId = plainResult.ok && Array.isArray(plainResult.raw) ? plainResult.raw[0]?.id : null;
  if (sampleId != null) {
    details = { attempted: true, sampleId, pathsTried: DETAIL_PATH_CANDIDATES.map((fn) => fn(sampleId)) };
    for (const pathFn of DETAIL_PATH_CANDIDATES) {
      try {
        const raw = await fetchJson(pathFn(sampleId));
        details.workingPath = pathFn(sampleId);
        details.raw = raw;
        details.extractedLocation = extractLocationField(raw);
        break;
      } catch (err) {
        details[`error:${pathFn(sampleId)}`] = err.message;
      }
    }
  }

  return {
    plain: plainResult,
    upcoming: describe(upcoming),
    details,
  };
}

module.exports = { fetchEvents, fetchSampleRaw };
