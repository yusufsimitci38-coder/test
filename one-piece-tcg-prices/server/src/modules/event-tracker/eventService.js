const config = require('../../config');
const db = require('../../db');
const { getProvider } = require('./providers');

async function refreshEvents() {
  const provider = getProvider();
  const events = await provider.fetchEvents();

  for (const event of events) {
    if (event.id) db.upsertEvent(event);
  }

  db.setMeta('eventsLastRefreshAt', new Date().toISOString());
  db.setMeta('eventsProvider', config.eventProvider);
  db.flushSync();

  return { count: events.length, at: db.getMeta('eventsLastRefreshAt') };
}

// month is "YYYY-MM"; returns every stored event whose date falls in that
// month, sorted chronologically. Omit month for the full stored list.
function getEvents(month) {
  const all = db.listEvents().filter((e) => e.date);
  const filtered = month ? all.filter((e) => e.date.slice(0, 7) === month) : all;
  return filtered.sort((a, b) => a.date.localeCompare(b.date));
}

function getStatus() {
  const events = db.listEvents();
  return {
    provider: config.eventProvider,
    lastRefreshAt: db.getMeta('eventsLastRefreshAt') || null,
    eventCount: events.length,
  };
}

async function debugSample() {
  const provider = getProvider();
  if (typeof provider.fetchSampleRaw !== 'function') {
    return { error: `The "${config.eventProvider}" provider doesn't support this diagnostic.` };
  }
  return provider.fetchSampleRaw();
}

module.exports = { refreshEvents, getEvents, getStatus, debugSample };
