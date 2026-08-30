const config = require('../../config');
const db = require('../../db');
const { getProvider } = require('./providers');
const { evaluateAlert, computeChange } = require('./alerts');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function refreshPrices() {
  const provider = getProvider();
  const cards = await provider.fetchWatchlistPrices(config.watchlist);
  const today = todayStr();

  for (const card of cards) {
    const { marketPrice, lowPrice, midPrice, highPrice, ...meta } = card;
    db.upsertCard(meta);
    db.addSnapshot(card.productId, today, { marketPrice, lowPrice, midPrice, highPrice });
  }

  // First run against the mock provider: backfill 40 days of synthetic
  // history so the "% change over the last month" math works immediately
  // instead of showing "not enough data" until real snapshots accumulate.
  if (typeof provider.getSeedHistory === 'function' && !db.getMeta('seeded')) {
    const seed = provider.getSeedHistory();
    for (const [productId, history] of seed) {
      for (const row of history) {
        const { date, ...prices } = row;
        db.addSnapshot(productId, date, prices);
      }
    }
    db.setMeta('seeded', true);
  }

  db.setMeta('lastRefreshAt', new Date().toISOString());
  db.setMeta('provider', config.priceProvider);
  db.flushSync();

  return { count: cards.length, at: db.getMeta('lastRefreshAt') };
}

function computeCardView(card) {
  const productId = card.productId;
  const snapshots = db.getSnapshots(productId);
  const latest = db.getLatestSnapshot(productId);
  const past = db.getSnapshotDaysAgo(productId, config.lookbackDays);
  const dayAgo = db.getSnapshotDaysAgo(productId, 1);
  const weekAgo = db.getSnapshotDaysAgo(productId, 7);

  const { pctChange, alert, direction } = evaluateAlert(latest?.marketPrice ?? null, past?.marketPrice ?? null);
  const daily = computeChange(latest?.marketPrice ?? null, dayAgo?.marketPrice ?? null);
  const weekly = computeChange(latest?.marketPrice ?? null, weekAgo?.marketPrice ?? null);

  return {
    ...card,
    currentPrice: latest?.marketPrice ?? null,
    priceLookbackDaysAgo: past?.marketPrice ?? null,
    pctChange,
    alert,
    direction,
    // The headline 30-day figure is provisional until we've actually
    // observed `lookbackDays` worth of snapshots for this card - current
    // price still shows immediately either way, this only gates the
    // month-over-month comparison and its alert.
    hasEnoughHistory: past !== null,
    historyDaysCollected: snapshots.length,
    historyDaysNeeded: config.lookbackDays,
    dailyChangePct: daily.pctChange,
    dailyDirection: daily.direction,
    weeklyChangePct: weekly.pctChange,
    weeklyDirection: weekly.direction,
    lastUpdated: latest?.date ?? null,
  };
}

function getCards({ alertsOnly = false, sort = 'pctChange' } = {}) {
  let views = db.listCards().map(computeCardView);
  if (alertsOnly) views = views.filter((v) => v.alert);

  const sorters = {
    pctChange: (a, b) => Math.abs(b.pctChange ?? 0) - Math.abs(a.pctChange ?? 0),
    price: (a, b) => (b.currentPrice ?? 0) - (a.currentPrice ?? 0),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  views.sort(sorters[sort] || sorters.pctChange);
  return views;
}

function getCardHistory(productId) {
  const card = db.getCard(productId);
  if (!card) return null;
  return { ...card, history: db.getSnapshots(productId) };
}

function getStatus() {
  const cards = db.listCards();
  const alertCount = cards.map(computeCardView).filter((c) => c.alert).length;
  return {
    provider: config.priceProvider,
    lastRefreshAt: db.getMeta('lastRefreshAt') || null,
    cardCount: cards.length,
    alertCount,
    thresholds: { minPrice: config.alertMinPrice, pctChange: config.alertPctChange, lookbackDays: config.lookbackDays },
    watchlist: config.watchlist,
  };
}

module.exports = { refreshPrices, getCards, getCardHistory, getStatus };
