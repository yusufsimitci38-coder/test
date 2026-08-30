// Real event provider, backed by https://play.limitlesstcg.com/api - a
// free, documented tournament database that includes One Piece Card Game
// events (game=OP): Regionals, Treasure Cups, online events, etc. No API
// key is required for the basic /tournaments endpoint.
//
// It does NOT carry registration/"application open" dates - only the event
// itself (name, date, format, organizer, player count). Each event's `url`
// links back to its page on Limitless, which is the place to find
// registration details for that specific event.

const { version } = require('../../../../package.json');

const BASE = 'https://play.limitlesstcg.com/api';
const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const GAME = 'OP';
const PAGE_SIZE = 100;
const MAX_PAGES = 6; // generous cap (up to 600 tournaments) against runaway pagination

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

  return [...merged.values()];
}

// Diagnostic only (not part of the shared provider contract): raw,
// untransformed sample from both listing paths, for checking the real
// field shape and confirming which paths actually work - used by
// GET /api/event-tracker/debug/sample.
async function fetchSampleRaw() {
  const [plain, upcoming] = await Promise.allSettled([
    fetchJson(`/tournaments?game=${GAME}&limit=3`),
    fetchJson(`/tournaments/upcoming?game=${GAME}&limit=3`),
  ]);
  const describe = (result) =>
    result.status === 'fulfilled' ? { ok: true, raw: result.value } : { ok: false, error: result.reason.message };
  return {
    plain: describe(plain),
    upcoming: describe(upcoming),
  };
}

module.exports = { fetchEvents, fetchSampleRaw };
