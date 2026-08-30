const config = require('../../config');
const db = require('../../db');
const { getProvider } = require('./providers');
const bandaiRegistration = require('./bandaiRegistration');

async function refreshEvents() {
  const provider = getProvider();
  const events = await provider.fetchEvents();

  for (const event of events) {
    if (event.id) db.upsertEvent(event);
  }

  db.setMeta('eventsLastRefreshAt', new Date().toISOString());
  db.setMeta('eventsProvider', config.eventProvider);

  // Best-effort and independent of the main event fetch above: a failure
  // scraping Bandai's site (no public API exists for this - see
  // bandaiRegistration.js) must never take down the regular event refresh.
  try {
    const windows = await bandaiRegistration.fetchRegistrationWindows();
    db.setMeta('registrationWindows', windows);
    db.setMeta('registrationWindowsLastRefreshAt', new Date().toISOString());
  } catch (err) {
    console.warn('[event-tracker] registration window refresh failed:', err.message);
  }

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

function getRegistrationWindows() {
  return {
    windows: db.getMeta('registrationWindows') || [],
    lastRefreshAt: db.getMeta('registrationWindowsLastRefreshAt') || null,
  };
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

async function debugBandaiRaw() {
  return bandaiRegistration.fetchRawText();
}

module.exports = {
  refreshEvents,
  getEvents,
  getRegistrationWindows,
  getStatus,
  debugSample,
  debugBandaiRaw,
};
