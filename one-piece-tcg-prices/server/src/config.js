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

  dataFile: require('path').join(__dirname, '..', 'data', 'db.json'),
};

module.exports = config;
