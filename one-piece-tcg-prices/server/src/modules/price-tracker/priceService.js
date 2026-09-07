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

  if (typeof provider.getLastFetchSummary === 'function') {
    db.setMeta('lastFetchSummary', provider.getLastFetchSummary());
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
    favorite: db.isFavorite(productId),
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

function getCards({ alertsOnly = false, favoritesOnly = false, sort = 'pctChange', color = '', setCode = '' } = {}) {
  let views = db.listCards().map(computeCardView);
  if (favoritesOnly) {
    // A favorite is an explicit choice - showing it never depends on
    // whether it currently happens to be above the unrelated price floor.
    views = views.filter((v) => v.favorite);
  } else {
    // Cards with no price yet (currentPrice null) are never hidden by this -
    // absence of a price isn't evidence the card belongs below the floor.
    views = views.filter((v) => v.currentPrice == null || v.currentPrice >= config.minDisplayPrice);
  }
  if (alertsOnly) views = views.filter((v) => v.alert);
  if (color) views = views.filter((v) => (v.color || '') === color);
  if (setCode) views = views.filter((v) => (v.setCode || '') === setCode);

  const byString = (key) => (a, b) => (a[key] || '').localeCompare(b[key] || '');
  const sorters = {
    // Needs `lookbackDays` (30, by default) worth of history to be
    // anything but null for every card - see weeklyChange below for a sort
    // that's meaningful well before then.
    pctChange: (a, b) => Math.abs(b.pctChange ?? 0) - Math.abs(a.pctChange ?? 0),
    weeklyChange: (a, b) => Math.abs(b.weeklyChangePct ?? 0) - Math.abs(a.weeklyChangePct ?? 0),
    dailyChange: (a, b) => Math.abs(b.dailyChangePct ?? 0) - Math.abs(a.dailyChangePct ?? 0),
    price: (a, b) => (b.currentPrice ?? 0) - (a.currentPrice ?? 0),
    name: (a, b) => a.name.localeCompare(b.name),
    color: byString('color'),
    set: byString('setCode'),
  };
  views.sort(sorters[sort] || sorters.pctChange);
  return views;
}

// Distinct filter values actually present in the tracked cards, so the UI
// can offer only choices that will return results instead of a hardcoded
// list that may not match what this watchlist/provider actually has.
function getFacets() {
  const cards = db.listCards();
  const colors = new Set();
  const setCodes = new Map(); // setCode -> a setName to show alongside it

  for (const card of cards) {
    if (card.color) colors.add(card.color);
    if (card.setCode && !setCodes.has(card.setCode)) setCodes.set(card.setCode, card.setName || card.setCode);
  }

  return {
    colors: [...colors].sort(),
    sets: [...setCodes.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code)),
  };
}

function getCardHistory(productId) {
  const card = db.getCard(productId);
  if (!card) return null;
  return { ...card, history: db.getSnapshots(productId) };
}

// Returns null (caller responds 404) for an unknown productId, otherwise
// the card's updated view - so the frontend can update its star state from
// the response instead of needing a second round-trip.
function setFavorite(productId, favorite) {
  if (!db.getCard(productId)) return null;
  db.setFavorite(productId, favorite);
  return computeCardView(db.getCard(productId));
}

function getStatus() {
  const cards = db.listCards();
  const views = cards.map(computeCardView);
  const alertCount = views.filter((c) => c.alert).length;
  // How far along the 30-day (by default) history window actually is right
  // now - the UI uses this to explain why sorting by the 30-day change
  // looks like a no-op (every card ties at null) until this catches up.
  const historyDaysCollected = views.length ? Math.max(...views.map((v) => v.historyDaysCollected)) : 0;
  const hiddenBelowMinPrice = views.filter(
    (v) => v.currentPrice != null && v.currentPrice < config.minDisplayPrice
  ).length;
  return {
    provider: config.priceProvider,
    lastRefreshAt: db.getMeta('lastRefreshAt') || null,
    cardCount: cards.length,
    alertCount,
    thresholds: {
      minPrice: config.alertMinPrice,
      pctChange: config.alertPctChange,
      lookbackDays: config.lookbackDays,
      minDisplayPrice: config.minDisplayPrice,
    },
    watchlist: config.watchlist,
    historyDaysCollected,
    hiddenBelowMinPrice,
  };
}

async function debugSampleProduct() {
  const provider = getProvider();
  if (typeof provider.fetchSampleRawProduct !== 'function') {
    return { error: `The "${config.priceProvider}" provider doesn't support this diagnostic.` };
  }
  return provider.fetchSampleRawProduct();
}

function getLastFetchSummary() {
  return db.getMeta('lastFetchSummary') || null;
}

async function debugCard(productId) {
  const trackedCard = db.getCard(productId);
  if (!trackedCard) {
    return { error: `No tracked card with productId ${productId}. Find the correct id via GET /cards, or from the number in its "View on TCGPlayer" link.` };
  }

  const provider = getProvider();
  if (typeof provider.fetchRawProductById !== 'function') {
    return { trackedCard, raw: { error: `The "${config.priceProvider}" provider doesn't support fetching raw source data.` } };
  }

  const raw = await provider.fetchRawProductById(trackedCard.setId, productId);
  return { trackedCard, raw };
}

module.exports = {
  refreshPrices,
  getCards,
  getCardHistory,
  getStatus,
  getFacets,
  setFavorite,
  debugSampleProduct,
  getLastFetchSummary,
  debugCard,
};
