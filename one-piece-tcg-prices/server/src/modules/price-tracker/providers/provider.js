// Contract every price provider must implement.
//
// fetchWatchlistPrices(watchlistConfig) resolves to an array of card records:
//   {
//     productId: number,
//     name: string,
//     setName: string,
//     setId: number | string,
//     number: string | null,
//     rarity: string | null,
//     imageUrl: string | null,
//     url: string,            // link back to the card's TCGPlayer product page
//     marketPrice: number | null,
//     lowPrice: number | null,
//     midPrice: number | null,
//     highPrice: number | null,
//   }
//
// watchlistConfig is the `watchlist` block from config.js: { mode, recentSetCount, setNames }.

module.exports = {};
