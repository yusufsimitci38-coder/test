// Optional second event source, merged alongside the main provider (see
// ../eventService.js) rather than swapped in via EVENT_PROVIDER: TopDeck.gg
// (https://topdeck.gg) is free tournament-management software many stores
// use for locals/weeklies, with a documented public API that - unlike
// Limitless, which is fundamentally a results database biased toward
// already-*held* events - defaults to future-dated tournaments. That makes
// it a genuinely different, complementary source for forward-looking
// calendar coverage, not just a duplicate of Limitless.
//
// Requires a free API key from https://topdeck.gg/developers, set as
// TOPDECK_API_KEY. Skipped entirely (no error, no calendar impact) when
// that's unset - this integration is opt-in.
//
// IMPORTANT: the exact request/response shape below is a best-effort
// reconstruction from TopDeck's public docs page and search-indexed
// snippets of it - this sandbox's network egress is blocked from
// topdeck.gg itself (same as every other real external site touched this
// session), so nothing here has been verified against a live response.
// Confirmed so far (via the docs page's own indexed content):
//   - POST https://topdeck.gg/api/v2/tournaments
//   - header: Authorization: <raw API key> (not a "Bearer " prefix)
//   - JSON body: { game, format, start } - "start" is a Unix timestamp,
//     and the endpoint defaults to future-dated tournaments
//   - rate limit: 100 requests/minute on standard endpoints
// NOT confirmed: the exact `game` string for One Piece TCG (guessed as
// "One Piece" below, mirroring the human-readable game names seen in docs
// examples like "Magic: The Gathering" - Limitless uses the terse "OP" by
// contrast, so don't assume the same convention carries over), the
// response envelope (array vs {data:[...]} vs {tournaments:[...]}), and
// per-tournament field names beyond a rough guess (tid/name/game/format/
// startDate/endDate/status, location nested somehow, decklist object).
// GET /api/event-tracker/debug/topdeck-sample returns the raw response (or
// error) for correcting these against live evidence, the same pattern used
// throughout this session for Limitless's detail endpoint and Bandai's
// registration-window scraping.

const config = require('../../../config');
const { version } = require('../../../../package.json');
const { isEnglishSpeaking } = require('../regionClassifier');

const API_URL = 'https://topdeck.gg/api/v2/tournaments';
const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const GAME = 'One Piece'; // best guess - see file header; correct via debug/topdeck-sample if wrong

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
      throw new Error(`${API_URL} -> HTTP ${res.status}`);
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

// Same candidate-key approach as limitlessProvider's extractLocationField -
// field name isn't confirmed, so several plausible ones are tried.
function extractLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;
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
  const id = raw?.tid ?? raw?.id ?? raw?._id;
  if (id == null) return null;
  const location = extractLocation(raw);
  return {
    id: `topdeck-${id}`,
    name: raw.name || 'Untitled event',
    date: toIsoDate(raw.startDate ?? raw.start ?? raw.date),
    format: raw.format || null,
    organizer: raw.organizer || raw.host || raw.owner || null,
    players: typeof raw.players === 'number' ? raw.players : typeof raw.playerCount === 'number' ? raw.playerCount : null,
    location,
    isEnglishSpeaking: isEnglishSpeaking(`${raw.name || ''} ${location || ''}`),
    // raw.url/link, if the API provides one, is trusted over this guessed
    // pattern (seen for TopDeck's own flagship events, e.g.
    // topdeck.gg/bracket/TopDeckOpen24) - not confirmed for API-sourced ids.
    url: raw.url || raw.link || `https://topdeck.gg/bracket/${id}`,
  };
}

// Returns [] (never throws) when no API key is configured or the request
// fails - this is an optional, best-effort second source; it must never
// block the primary event refresh.
async function fetchEvents() {
  if (!config.topdeckApiKey) return [];
  try {
    const json = await postJson({ game: GAME, start: Math.floor(Date.now() / 1000) });
    return extractList(json).map(normalizeEvent).filter(Boolean);
  } catch (err) {
    console.warn(`[topdeck] couldn't fetch tournaments (${err.message})`);
    return [];
  }
}

// Diagnostic only: the raw request/response (or error), for checking the
// real field shape against the guesses above - used by
// GET /api/event-tracker/debug/topdeck-sample.
async function fetchSampleRaw() {
  if (!config.topdeckApiKey) {
    return { configured: false, note: 'TOPDECK_API_KEY is not set - this integration is skipped entirely until it is.' };
  }
  const payload = { game: GAME, start: Math.floor(Date.now() / 1000) };
  try {
    const raw = await postJson(payload);
    return { configured: true, requestPayload: payload, ok: true, raw };
  } catch (err) {
    return { configured: true, requestPayload: payload, ok: false, error: err.message };
  }
}

module.exports = { fetchEvents, fetchSampleRaw };
