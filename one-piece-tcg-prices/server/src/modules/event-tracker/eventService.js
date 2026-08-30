const config = require('../../config');
const db = require('../../db');
const { getProvider } = require('./providers');
const bandaiRegistration = require('./bandaiRegistration');
const topdeckProvider = require('./providers/topdeckProvider');
const { mergeEvents } = require('./mergeEvents');

// Guards against two refreshes running at once - e.g. the automatic
// first-boot refresh (server/src/index.js) overlapping with a user-clicked
// "Refresh now" right after a redeploy, which would double the request
// volume against both Limitless and TopDeck and make rate limiting worse,
// not better. A second caller gets back the same in-flight result instead
// of kicking off its own concurrent refresh.
let refreshInFlight = null;

async function refreshEvents() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshEvents().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshEvents() {
  const provider = getProvider();
  const primaryEvents = await provider.fetchEvents();

  // Optional second source (see providers/topdeckProvider.js) - a no-op
  // returning [] when TOPDECK_API_KEY isn't configured. Best-effort and
  // independent of the primary fetch: a failure here must never take down
  // the regular event refresh.
  let events = primaryEvents;
  try {
    const topdeckEvents = await topdeckProvider.fetchEvents();
    if (topdeckEvents.length) events = mergeEvents(primaryEvents, topdeckEvents);
  } catch (err) {
    console.warn('[event-tracker] TopDeck merge failed:', err.message);
  }

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

async function debugTopdeckRaw() {
  return topdeckProvider.fetchSampleRaw();
}

module.exports = {
  refreshEvents,
  getEvents,
  getRegistrationWindows,
  getStatus,
  debugSample,
  debugBandaiRaw,
  debugTopdeckRaw,
};
