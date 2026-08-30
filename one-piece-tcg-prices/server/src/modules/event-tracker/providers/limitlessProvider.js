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

async function fetchEvents() {
  const events = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchJson(`/tournaments?game=${GAME}&limit=${PAGE_SIZE}&page=${page}`);
    const list = Array.isArray(batch) ? batch : Array.isArray(batch?.tournaments) ? batch.tournaments : [];
    if (!list.length) break;
    events.push(...list.map(normalizeEvent).filter(Boolean));
    if (list.length < PAGE_SIZE) break; // reached the last page
  }
  return events;
}

// Diagnostic only (not part of the shared provider contract): raw,
// untransformed sample of what the API actually returns, for checking the
// real field shape - used by GET /api/event-tracker/debug/sample.
async function fetchSampleRaw() {
  const batch = await fetchJson(`/tournaments?game=${GAME}&limit=3`);
  return { url: `${BASE}/tournaments?game=${GAME}&limit=3`, raw: batch };
}

module.exports = { fetchEvents, fetchSampleRaw };
