// Real price provider, backed by https://tcgcsv.com - a free, no-API-key
// mirror of TCGPlayer's public categories/groups/products/prices endpoints.
// (TCGPlayer's own API has been closed to new developer applications since
// 2024, so this is the practical way to read TCGPlayer market prices
// without an existing partner key. See README.md for details and for how
// to swap in the official API if you do have credentials.)

const config = require('../../../config');
const { version } = require('../../../../package.json');

const BASE = 'https://tcgcsv.com/tcgplayer';
const ONE_PIECE_NAME_RE = /one piece/i;
// tcgcsv.com's docs (tcgcsv.com/docs) say requests with a generic or missing
// User-Agent may be rejected (this is what was showing up as an HTTP 401),
// and ask callers to identify themselves and keep request volume modest.
const USER_AGENT = `OnePieceTCGToolkit/${version || '0.0.0'}`;
const BETWEEN_REQUESTS_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`${url} -> HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// tcgcsv mirrors TCGPlayer's own response envelope: { success, errors, results }.
function unwrap(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.results)) return json.results;
  return [];
}

let cachedCategoryId = config.onePieceCategoryId || null;

async function findOnePieceCategoryId() {
  if (cachedCategoryId) return cachedCategoryId;
  const json = await fetchJson(`${BASE}/categories`);
  const categories = unwrap(json);
  const match = categories.find((c) => ONE_PIECE_NAME_RE.test(c.name || ''));
  if (!match) {
    throw new Error('Could not find a "One Piece" category on tcgcsv.com - the site layout may have changed.');
  }
  cachedCategoryId = match.categoryId;
  return cachedCategoryId;
}

async function listGroups(categoryId) {
  const json = await fetchJson(`${BASE}/${categoryId}/groups`);
  return unwrap(json);
}

async function listProducts(categoryId, groupId) {
  const json = await fetchJson(`${BASE}/${categoryId}/${groupId}/products`);
  return unwrap(json);
}

async function listPrices(categoryId, groupId) {
  const json = await fetchJson(`${BASE}/${categoryId}/${groupId}/prices`);
  return unwrap(json);
}

function extendedField(product, patterns) {
  const fields = product.extendedData;
  if (!Array.isArray(fields)) return null;
  for (const pattern of patterns) {
    const hit = fields.find((f) => pattern.test(f.name || f.displayName || ''));
    if (hit) return hit.value ?? null;
  }
  return null;
}

function normalizeColor(value) {
  if (!value) return null;
  return value
    .split(/[;/]/)
    .map((c) => c.trim())
    .filter(Boolean)
    .join('/');
}

// Card numbers are formatted like "OP13-001", "EB04-036", "ST01-001" - the
// part before the dash is the short set code players actually search by
// (OP17, EB04, ...), which is more reliable for this than the group's own
// abbreviation field (not consistently present, and the full group name
// like "OP-13 The Three Captains" isn't the compact code people expect).
function deriveSetCode(number, group) {
  if (number && number.includes('-')) {
    return number.split('-')[0].trim().toUpperCase();
  }
  return group.abbreviation || null;
}

function pickGroups(groups, watchlistConfig) {
  const sorted = [...groups].sort((a, b) => {
    const ap = a.publishedOn ? Date.parse(a.publishedOn) : 0;
    const bp = b.publishedOn ? Date.parse(b.publishedOn) : 0;
    if (bp !== ap) return bp - ap;
    return (b.groupId || 0) - (a.groupId || 0);
  });

  switch (watchlistConfig.mode) {
    case 'all-sets':
      return sorted;
    case 'named-sets': {
      const wanted = new Set(watchlistConfig.setNames.map((n) => n.toLowerCase()));
      return sorted.filter((g) => wanted.has((g.name || '').toLowerCase()));
    }
    case 'recent-sets':
    default: {
      // publishedOn can be in the future for presale/announced sets, which
      // otherwise sort ahead of everything actually released - a presale
      // set has no market data yet, so picking it here mostly just fills a
      // watchlist slot with cards that never get a price. "Recent" means
      // the most recently *released* sets, so exclude anything not out yet.
      const now = Date.now();
      const released = sorted.filter((g) => !g.publishedOn || Date.parse(g.publishedOn) <= now);
      return released.slice(0, watchlistConfig.recentSetCount);
    }
  }
}

async function fetchWatchlistPrices(watchlistConfig) {
  const categoryId = await findOnePieceCategoryId();
  const allGroups = await listGroups(categoryId);
  const groups = pickGroups(allGroups, watchlistConfig);

  const cards = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) await sleep(BETWEEN_REQUESTS_MS);

    let products, prices;
    try {
      [products, prices] = await Promise.all([
        listProducts(categoryId, group.groupId),
        listPrices(categoryId, group.groupId),
      ]);
    } catch (err) {
      console.warn(`[tcgcsv] skipping set "${group.name}" (${group.groupId}): ${err.message}`);
      continue;
    }

    const priceByProduct = new Map();
    for (const p of prices) {
      const key = p.productId;
      // A product can have multiple price rows (e.g. Normal vs Foil printing);
      // prefer "Normal", otherwise keep the first one we see.
      if (!priceByProduct.has(key) || /normal/i.test(p.subTypeName || '')) {
        priceByProduct.set(key, p);
      }
    }

    for (const product of products) {
      const price = priceByProduct.get(product.productId);
      if (!price) continue; // no listing/price data for this product right now

      const number = extendedField(product, [/number/i]);

      cards.push({
        productId: product.productId,
        name: product.name,
        setName: group.name,
        setId: group.groupId,
        setCode: deriveSetCode(number, group),
        number,
        rarity: extendedField(product, [/rarity/i]),
        // Dual-color cards come back as "Green;Purple" (semicolon); normalized
        // to "Green/Purple" so it matches the one delimiter the UI (and the
        // mock provider's sample data) expects everywhere else. Otherwise
        // kept as the raw combined string rather than split into an array,
        // so the filter list shows combos as their own distinct entries.
        color: normalizeColor(extendedField(product, [/^color$/i, /color/i])),
        imageUrl: product.imageUrl || `https://tcgplayer-cdn.tcgplayer.com/product/${product.productId}_200w.jpg`,
        url: product.url || `https://www.tcgplayer.com/product/${product.productId}`,
        marketPrice: numOrNull(price.marketPrice),
        lowPrice: numOrNull(price.lowPrice),
        midPrice: numOrNull(price.midPrice),
        highPrice: numOrNull(price.highPrice),
      });
    }
  }

  return cards;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Diagnostic only (not part of the shared provider contract): returns one
// raw, untransformed product + price record straight from tcgcsv.com so we
// can see its actual field names/shapes instead of guessing at them - used
// by GET /api/price-tracker/debug/sample-product.
async function fetchSampleRawProduct() {
  const categoryId = await findOnePieceCategoryId();
  const allGroups = await listGroups(categoryId);
  const [group] = pickGroups(allGroups, { mode: 'recent-sets', recentSetCount: 1, setNames: [] });
  if (!group) return { error: 'No groups found for the One Piece category.' };

  const [products, prices] = await Promise.all([
    listProducts(categoryId, group.groupId),
    listPrices(categoryId, group.groupId),
  ]);
  const product = products[0] || null;
  const price = product ? prices.find((p) => p.productId === product.productId) || null : null;

  return {
    categoryId,
    group,
    product,
    price,
    extendedDataFieldNames: Array.isArray(product?.extendedData)
      ? product.extendedData.map((f) => f.name || f.displayName)
      : null,
  };
}

module.exports = { fetchWatchlistPrices, fetchSampleRawProduct };
