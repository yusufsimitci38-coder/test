require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: num(process.env.PORT, 4000),
  priceProvider: process.env.PRICE_PROVIDER || 'tcgcsv',

  alertMinPrice: num(process.env.ALERT_MIN_PRICE, 4),
  alertPctChange: num(process.env.ALERT_PCT_CHANGE, 20),
  lookbackDays: num(process.env.LOOKBACK_DAYS, 30),

  // Display-only floor: hides cards currently priced below this from the
  // card list entirely (cards with no price yet - e.g. right after being
  // added, before their first refresh - are never hidden by this, since
  // absence of a price isn't evidence it belongs below the floor).
  // Independent of ALERT_MIN_PRICE above - a card can be shown here but
  // still never qualify for an alert, and vice versa isn't possible since
  // alerting already requires currentPrice >= alertMinPrice.
  minDisplayPrice: num(process.env.MIN_DISPLAY_PRICE, 2),

  watchlist: {
    mode: process.env.WATCHLIST_MODE || 'all-sets',
    recentSetCount: num(process.env.RECENT_SET_COUNT, 8),
    setNames: (process.env.WATCHLIST_SET_NAMES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  refreshCron: process.env.REFRESH_CRON || '0 13 * * *',
  onePieceCategoryId: process.env.ONEPIECE_CATEGORY_ID
    ? num(process.env.ONEPIECE_CATEGORY_ID, undefined)
    : undefined,

  eventProvider: process.env.EVENT_PROVIDER || 'limitless',
  eventRefreshCron: process.env.EVENT_REFRESH_CRON || '30 13 * * *',

  // Optional: merges TopDeck.gg tournaments into the calendar alongside the
  // main event provider (see topdeckProvider.js). Skipped entirely, with no
  // error, when unset - this is opt-in, not a required credential.
  topdeckApiKey: process.env.TOPDECK_API_KEY || null,

  dataFile: require('path').join(__dirname, '..', 'data', 'db.json'),
};

module.exports = config;
