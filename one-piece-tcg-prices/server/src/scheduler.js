const cron = require('node-cron');
const config = require('./config');
const priceTracker = require('./modules/price-tracker/priceService');

function start() {
  cron.schedule(config.refreshCron, () => {
    console.log('[scheduler] running daily price refresh...');
    priceTracker
      .refreshPrices()
      .then((r) => console.log(`[scheduler] refreshed ${r.count} cards at ${r.at}`))
      .catch((err) => console.error('[scheduler] refresh failed:', err));
  });
  console.log(`[scheduler] daily refresh scheduled ("${config.refreshCron}", UTC)`);
}

module.exports = { start };
