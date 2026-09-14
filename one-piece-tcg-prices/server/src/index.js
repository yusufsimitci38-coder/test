const config = require('./config');
const app = require('./app');
const scheduler = require('./scheduler');
const priceTracker = require('./modules/price-tracker/priceService');
const eventTracker = require('./modules/event-tracker/eventService');

async function main() {
  app.listen(config.port, () => {
    console.log(`One Piece TCG Toolkit listening on http://localhost:${config.port}`);
  });

  scheduler.start();

  // Populate data on first boot so the dashboard isn't empty while waiting
  // for the next scheduled refresh.
  const priceStatus = priceTracker.getStatus();
  if (priceStatus.cardCount === 0) {
    console.log('[startup] no cached price data yet, running an initial price refresh...');
    try {
      const result = await priceTracker.refreshPrices();
      console.log(`[startup] loaded ${result.count} cards.`);
    } catch (err) {
      console.error('[startup] initial price refresh failed:', err.message);
      console.error('[startup] the dashboard will retry on the next scheduled refresh, or via "Refresh now".');
    }
  }

  const eventStatus = eventTracker.getStatus();
  if (eventStatus.eventCount === 0) {
    console.log('[startup] no cached event data yet, running an initial event refresh...');
    try {
      const result = await eventTracker.refreshEvents();
      console.log(`[startup] loaded ${result.count} events.`);
    } catch (err) {
      console.error('[startup] initial event refresh failed:', err.message);
      console.error('[startup] the calendar will retry on the next scheduled refresh, or via "Refresh now".');
    }
  }
}

main();
