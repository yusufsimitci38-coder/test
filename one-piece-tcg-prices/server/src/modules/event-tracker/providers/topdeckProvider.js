// Optional second event source, merged alongside the main provider (see
// ../eventService.js) rather than swapped in via EVENT_PROVIDER: TopDeck.gg
// (https://topdeck.gg) is free tournament-management software many stores
// use for locals/weeklies - a genuinely different, complementary source
// from Limitless, not just a duplicate of it.
//
// Requires a free API key from https://topdeck.gg/developers, set as
// TOPDECK_API_KEY. Skipped entirely (no error, no calendar impact) when
// that's unset - this integration is opt-in.
//
// Confirmed against a real live response (this sandbox's network egress is
// blocked from topdeck.gg itself, so this took a few rounds of the same
// debug-endpoint-plus-real-evidence pattern used for Limitless's detail
// endpoint and Bandai's registration-window scraping):
//   - POST https://topdeck.gg/api/v2/tournaments
//   - header: Authorization: <raw API key> (not a "Bearer " prefix)
//   - JSON body REQUIRES both "game" AND "format" (a request with only one
//     of them is rejected with HTTP 400 "Both ... fields are required" -
//     this cost the original version of this file its entire fetchEvents()
//     path, since it only ever sent "game", never "format")
//   - game: "One Piece" (the original guess was right all along - the
//     earlier 400s were about the missing "format" field, not this)
//   - format: "Standard" (the only format seen in real data so far)
//   - "start" is a Unix-seconds timestamp; confirmed NOT to default to
//     future-dated tournaments - it's a plain "startDate >= start" filter,
//     same idea as Limitless's absence of a dedicated "upcoming" concept
//     for this specific query. A real response with start=0 returned a
//     *completed* tournament (full standings/decklists), so this looks
//     like the same kind of results-oriented data as Limitless, not
//     inherently forward-looking - whether TopDeck has anything genuinely
//     upcoming for One Piece at any given moment is going to vary
//   - response envelope: a plain JSON array (not {data:[...]} etc, though
//     that's still tolerated defensively below in case it varies)
//   - per-tournament fields, from one real completed tournament: TID
//     (note the case - not "tid"), tournamentName (not "name"), startDate
//     (Unix seconds), game, format, topCut, swissNum, standings (an array,
//     one per player - no separate player-count field), and eventData -
//     an object with headerImage and address (the *only* location-ish
//     field seen; nothing top-level like the location/venue/city guessed
//     originally). No organizer/host field was present in that response.
// GET /api/event-tracker/debug/topdeck-sample (with ?game=/?format=/
// ?start= overrides) is how all of the above was actually confirmed - keep
// using it if TopDeck's shape drifts again.

const config = require('../../../config');
const { version } = require('../../../../package.json');
const { isEnglishSpeaking } = require('../regionClassifier');

const API_URL = 'https://topdeck.gg/api/v2/tournaments';
const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const GAME = 'One Piece';
const FORMAT = 'Standard';

async function postJson(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: config.topdeckApiKey,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // A 4xx validation error often names the actual problem (e.g. which
      // game values are valid) in its body - worth surfacing verbatim
      // rather than just the status code, especially while the request
      // shape here is still an unverified guess (see file header).
      const bodyText = await res.text().catch(() => '');
      throw new Error(`${API_URL} -> HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractList(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.tournaments)) return json.tournaments;
  if (Array.isArray(json?.results)) return json.results;
  return [];
}

// Confirmed real shape: raw.eventData.address (e.g. "Tabletop Gaming Hall
// A3"). The other candidates are kept as a defensive fallback in case some
// tournaments structure this differently.
function extractLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const eventDataAddress = raw.eventData?.address;
  if (typeof eventDataAddress === 'string' && eventDataAddress.trim()) return eventDataAddress.trim();

  for (const key of ['location', 'venue', 'address', 'city']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
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

// startDate's exact format isn't confirmed (Unix seconds is the guess,
// matching the "start" request parameter being described as a Unix
// timestamp) - tolerates seconds, milliseconds, or an ISO/date string.
function toIsoDate(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value; // seconds vs ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeEvent(raw) {
  // TID (this exact casing) is the confirmed real id field; the others are
  // kept as a defensive fallback only.
  const id = raw?.TID ?? raw?.tid ?? raw?.id ?? raw?._id;
  if (id == null) return null;
  const location = extractLocation(raw);
  const name = raw.tournamentName || raw.name || 'Untitled event';
  return {
    id: `topdeck-${id}`,
    name,
    date: toIsoDate(raw.startDate ?? raw.start ?? raw.date),
    format: raw.format || null,
    organizer: raw.organizer || raw.host || raw.owner || null,
    // No dedicated player-count field was seen in a real response -
    // standings is one entry per player, so its length is a reasonable
    // stand-in (naturally null/0 for a tournament that hasn't been played
    // yet and has no standings recorded).
    players: typeof raw.players === 'number'
      ? raw.players
      : typeof raw.playerCount === 'number'
        ? raw.playerCount
        : Array.isArray(raw.standings)
          ? raw.standings.length
          : null,
    location,
    isEnglishSpeaking: isEnglishSpeaking(`${name} ${location || ''}`),
    // TID looks like a URL-safe slug (e.g. "one-piece-standard-constructed-
    // swiss-1"), matching the pattern seen for TopDeck's own flagship
    // events (e.g. topdeck.gg/bracket/TopDeckOpen24) - raw.url/link, if the
    // API ever provides one directly, is trusted over this guess.
    url: raw.url || raw.link || `https://topdeck.gg/bracket/${id}`,
  };
}

// Returns [] (never throws) when no API key is configured or the request
// fails - this is an optional, best-effort second source; it must never
// block the primary event refresh.
async function fetchEvents() {
  if (!config.topdeckApiKey) return [];
  try {
    // Both game and format are required by the API - a request with only
    // one is rejected outright (HTTP 400), which is what silently zeroed
    // out this entire function before format was added here.
    const json = await postJson({ game: GAME, format: FORMAT, start: Math.floor(Date.now() / 1000) });
    return extractList(json).map(normalizeEvent).filter(Boolean);
  } catch (err) {
    console.warn(`[topdeck] couldn't fetch tournaments (${err.message})`);
    return [];
  }
}

// Diagnostic only: the raw request/response (or error), for checking the
// real field shape against the code above - used by
// GET /api/event-tracker/debug/topdeck-sample. Defaults to the same
// game/format fetchEvents() uses, but accepts overrides (e.g.
// ?game=One+Piece+TCG, or ?omitGame=1 to test the API's own validation)
// for trying candidates directly against the live API without a redeploy.
async function fetchSampleRaw({ game, format, gameOmitted, start } = {}) {
  if (!config.topdeckApiKey) {
    return { configured: false, note: 'TOPDECK_API_KEY is not set - this integration is skipped entirely until it is.' };
  }
  const payload = { start: start != null ? start : Math.floor(Date.now() / 1000) };
  if (!gameOmitted) payload.game = game || GAME;
  payload.format = format || FORMAT;
  try {
    const raw = await postJson(payload);
    return { configured: true, requestPayload: payload, ok: true, raw };
  } catch (err) {
    return { configured: true, requestPayload: payload, ok: false, error: err.message };
  }
}

module.exports = { fetchEvents, fetchSampleRaw };
