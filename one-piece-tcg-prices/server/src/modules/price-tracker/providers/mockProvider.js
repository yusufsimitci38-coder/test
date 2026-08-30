// Deterministic sample data - no network access required. Useful for local
// development/demos, and as a fallback if tcgcsv.com is ever unreachable.
// Prices are a seeded random walk over the trailing 40 days so the alert
// logic has something interesting to show on a fresh checkout.

const SAMPLE_CARDS = [
  { productId: 500001, name: 'Monkey D. Luffy (Alt Art)', setName: 'OP-01 Romance Dawn', setId: 'mock-op01', number: 'OP01-005', rarity: 'SR', start: 42 },
  { productId: 500002, name: 'Roronoa Zoro', setName: 'OP-01 Romance Dawn', setId: 'mock-op01', number: 'OP01-025', rarity: 'L', start: 8 },
  { productId: 500003, name: 'Trafalgar Law (Manga Art)', setName: 'OP-02 Paramount War', setId: 'mock-op02', number: 'OP02-001', rarity: 'SEC', start: 65 },
  { productId: 500004, name: 'Nami', setName: 'OP-01 Romance Dawn', setId: 'mock-op01', number: 'OP01-016', rarity: 'R', start: 3.5 },
  { productId: 500005, name: 'Shanks', setName: 'OP-01 Romance Dawn', setId: 'mock-op01', number: 'OP01-120', rarity: 'SEC', start: 120 },
  { productId: 500006, name: 'Portgas D. Ace', setName: 'OP-02 Paramount War', setId: 'mock-op02', number: 'OP02-013', rarity: 'SR', start: 15 },
  { productId: 500007, name: 'Charlotte Katakuri', setName: 'OP-03 Pillars of Strength', setId: 'mock-op03', number: 'OP03-098', rarity: 'SEC', start: 55 },
  { productId: 500008, name: 'Boa Hancock', setName: 'OP-06 Wings of the Captain', setId: 'mock-op06', number: 'OP06-043', rarity: 'SR', start: 6 },
  { productId: 500009, name: 'Common Filler Card', setName: 'OP-01 Romance Dawn', setId: 'mock-op01', number: 'OP01-050', rarity: 'C', start: 0.35 },
  { productId: 500010, name: 'Yamato', setName: 'OP-04 Kingdoms of Intrigue', setId: 'mock-op04', number: 'OP04-020', rarity: 'SR', start: 9 },
];

// Small deterministic PRNG (mulberry32) so every run produces the same history.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHistory(productId, start, days) {
  const rand = mulberry32(productId);
  const history = [];
  let price = start;
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    // Gentle random walk, occasionally punctuated by a sharper move so some
    // cards clearly cross the alert threshold and others clearly don't.
    const drift = (rand() - 0.5) * 0.04;
    const spike = rand() < 0.06 ? (rand() - 0.5) * 0.5 : 0;
    price = Math.max(0.1, price * (1 + drift + spike));

    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - i);
    history.push({
      date: date.toISOString().slice(0, 10),
      marketPrice: Math.round(price * 100) / 100,
      lowPrice: Math.round(price * 0.85 * 100) / 100,
      midPrice: Math.round(price * 100) / 100,
      highPrice: Math.round(price * 1.2 * 100) / 100,
    });
  }
  return history;
}

async function fetchWatchlistPrices() {
  // The "fetch" only returns today's snapshot per the provider contract;
  // priceService asks for history separately via getSeedHistory below.
  return SAMPLE_CARDS.map((card) => {
    const history = buildHistory(card.productId, card.start, 40);
    const latest = history[history.length - 1];
    return {
      productId: card.productId,
      name: card.name,
      setName: card.setName,
      setId: card.setId,
      number: card.number,
      rarity: card.rarity,
      imageUrl: null,
      url: `https://www.tcgplayer.com/product/${card.productId}`,
      marketPrice: latest.marketPrice,
      lowPrice: latest.lowPrice,
      midPrice: latest.midPrice,
      highPrice: latest.highPrice,
    };
  });
}

// Extra hook (not part of the shared provider contract) that priceService
// uses once, on first run, to seed 40 days of mock history so the alert
// math has something to compare against immediately instead of waiting a
// month for real snapshots to accumulate.
function getSeedHistory() {
  const map = new Map();
  for (const card of SAMPLE_CARDS) {
    map.set(card.productId, buildHistory(card.productId, card.start, 40));
  }
  return map;
}

module.exports = { fetchWatchlistPrices, getSeedHistory };
