const cron = require('node-cron');
const config = require('./config');
const priceTracker = require('./modules/price-tracker/priceService');
const eventTracker = require('./modules/event-tracker/eventService');

function start() {
  cron.schedule(config.refreshCron, () => {
    console.log('[scheduler] running daily price refresh...');
    priceTracker
      .refreshPrices()
      .then((r) => console.log(`[scheduler] refreshed ${r.count} cards at ${r.at}`))
      .catch((err) => console.error('[scheduler] price refresh failed:', err));
  });
  console.log(`[scheduler] daily price refresh scheduled ("${config.refreshCron}", UTC)`);

  cron.schedule(config.eventRefreshCron, () => {
    console.log('[scheduler] running daily event refresh...');
    eventTracker
      .refreshEvents()
      .then((r) => console.log(`[scheduler] refreshed ${r.count} events at ${r.at}`))
      .catch((err) => console.error('[scheduler] event refresh failed:', err));
  });
  console.log(`[scheduler] daily event refresh scheduled ("${config.eventRefreshCron}", UTC)`);
}

module.exports = { start };
