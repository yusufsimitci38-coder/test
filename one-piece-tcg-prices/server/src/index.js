const config = require('./config');
const app = require('./app');
const scheduler = require('./scheduler');
const priceTracker = require('./modules/price-tracker/priceService');

async function main() {
  app.listen(config.port, () => {
    console.log(`One Piece TCG price tracker listening on http://localhost:${config.port}`);
  });

  scheduler.start();

  // Populate data on first boot so the dashboard isn't empty while waiting
  // for the next scheduled refresh.
  const status = priceTracker.getStatus();
  if (status.cardCount === 0) {
    console.log('[startup] no cached data yet, running an initial price refresh...');
    try {
      const result = await priceTracker.refreshPrices();
      console.log(`[startup] loaded ${result.count} cards.`);
    } catch (err) {
      console.error('[startup] initial refresh failed:', err.message);
      console.error('[startup] the dashboard will retry on the next scheduled refresh, or via "Refresh now".');
    }
  }
}

main();
