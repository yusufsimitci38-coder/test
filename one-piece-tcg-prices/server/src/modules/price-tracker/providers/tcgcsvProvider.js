// Real price provider, backed by https://tcgcsv.com - a free, no-API-key
// mirror of TCGPlayer's public categories/groups/products/prices endpoints.
// (TCGPlayer's own API has been closed to new developer applications since
// 2024, so this is the practical way to read TCGPlayer market prices
// without an existing partner key. See README.md for details and for how
// to swap in the official API if you do have credentials.)

const config = require('../../../config');

const BASE = 'https://tcgcsv.com/tcgplayer';
const ONE_PIECE_NAME_RE = /one piece/i;

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
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
    default:
      return sorted.slice(0, watchlistConfig.recentSetCount);
  }
}

async function fetchWatchlistPrices(watchlistConfig) {
  const categoryId = await findOnePieceCategoryId();
  const allGroups = await listGroups(categoryId);
  const groups = pickGroups(allGroups, watchlistConfig);

  const cards = [];
  for (const group of groups) {
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

      cards.push({
        productId: product.productId,
        name: product.name,
        setName: group.name,
        setId: group.groupId,
        number: extendedField(product, [/number/i]),
        rarity: extendedField(product, [/rarity/i]),
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

module.exports = { fetchWatchlistPrices };
