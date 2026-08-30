// Lightweight JSON-file data store. The watchlist tops out at a few hundred
// cards with one snapshot row/day each, which stays well within what a flat
// file can comfortably hold - no need for a database engine at this scale.
// If a later module (e.g. the event tracker) needs real relational storage,
// swap this module out; nothing outside db.js knows the storage format.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const EMPTY_STATE = { cards: {}, snapshots: {}, events: {}, meta: {} };

let state = null;

function load() {
  if (state) return state;
  try {
    const raw = fs.readFileSync(config.dataFile, 'utf8');
    state = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = structuredClone(EMPTY_STATE);
  }
  state.cards ||= {};
  state.snapshots ||= {};
  state.events ||= {};
  state.meta ||= {};
  return state;
}

let saveTimer = null;
let warnedAboutDisk = false;
function persistToDisk() {
  try {
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
    fs.writeFileSync(config.dataFile, JSON.stringify(state, null, 2));
  } catch (err) {
    // Some hosts (e.g. Railway without a mounted volume) run the app on a
    // read-only or ephemeral filesystem. Losing persistence there just means
    // data resets on restart - it must never crash the process, since an
    // uncaught exception here (this runs inside a bare setTimeout callback)
    // would kill the whole server and make every request start timing out.
    if (!warnedAboutDisk) {
      console.warn(
        `[db] could not write ${config.dataFile} (${err.message}). ` +
          'Data will not persist across restarts - if this is unexpected, check that the app has a writable/mounted data directory.'
      );
      warnedAboutDisk = true;
    }
  }
}

function save() {
  // Debounce writes so a burst of upserts during a refresh doesn't hammer disk.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistToDisk();
  }, 50);
}

function flushSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!state) return;
  persistToDisk();
}

function upsertCard(card) {
  const s = load();
  const key = String(card.productId);
  s.cards[key] = { ...s.cards[key], ...card, updatedAt: new Date().toISOString() };
  save();
}

function addSnapshot(productId, dateStr, prices) {
  const s = load();
  const key = String(productId);
  s.snapshots[key] ||= [];
  const list = s.snapshots[key];
  const existingIdx = list.findIndex((row) => row.date === dateStr);
  const row = { date: dateStr, ...prices };
  if (existingIdx >= 0) list[existingIdx] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  save();
}

function listCards() {
  const s = load();
  return Object.values(s.cards);
}

function getCard(productId) {
  const s = load();
  return s.cards[String(productId)] || null;
}

function getSnapshots(productId) {
  const s = load();
  return s.snapshots[String(productId)] || [];
}

function getLatestSnapshot(productId) {
  const rows = getSnapshots(productId);
  return rows.length ? rows[rows.length - 1] : null;
}

// Most recent snapshot at or before `days` ago - i.e. "the price roughly a
// month back". Returns null if we don't have anything that old yet.
function getSnapshotDaysAgo(productId, days) {
  const rows = getSnapshots(productId);
  if (!rows.length) return null;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let candidate = null;
  for (const row of rows) {
    if (row.date <= cutoffStr) candidate = row;
    else break;
  }
  return candidate;
}

function upsertEvent(event) {
  const s = load();
  const key = String(event.id);
  s.events[key] = { ...s.events[key], ...event, updatedAt: new Date().toISOString() };
  save();
}

function listEvents() {
  const s = load();
  return Object.values(s.events);
}

function getEvent(id) {
  const s = load();
  return s.events[String(id)] || null;
}

function setMeta(key, value) {
  const s = load();
  s.meta[key] = value;
  save();
}

function getMeta(key) {
  const s = load();
  return s.meta[key];
}

process.on('exit', flushSync);

module.exports = {
  upsertCard,
  addSnapshot,
  listCards,
  getCard,
  getSnapshots,
  getLatestSnapshot,
  getSnapshotDaysAgo,
  upsertEvent,
  listEvents,
  getEvent,
  setMeta,
  getMeta,
  flushSync,
};
