# One Piece TCG Toolkit — Price Tracker

Tracks TCGPlayer market prices for One Piece Card Game singles and flags
cards that have moved a lot recently: **price ≥ $4 and a ≥ 20% change over
the trailing 30 days** (both thresholds are configurable).

This is module 1 of a planned toolkit — an **event tracker** for One Piece
TCG tournaments/locals is intended to follow as a second module, sharing
this same server and UI shell (see [Architecture](#architecture)).

## Why this doesn't scrape tcgplayer.com directly

TCGPlayer's official pricing API (`api.tcgplayer.com`) is the correct,
ToS-compliant way to get this data, but **TCGPlayer stopped accepting new
developer applications in 2024** — so a fresh project can't just sign up
for a key. Scraping `tcgplayer.com`'s HTML directly is against their Terms
of Service and is actively blocked (Cloudflare, etc.), so this app doesn't
do that either.

Instead, by default it reads from **[tcgcsv.com](https://tcgcsv.com)**, a
free, no-API-key mirror of TCGPlayer's own categories/groups/products/prices
endpoints, built specifically so developers can keep working now that new
TCGPlayer API access is closed. It's read-only and requires no credentials.

If you (or the person running this) already have TCGPlayer API credentials,
swap them in — see [Using the official TCGPlayer API instead](#using-the-official-tcgplayer-api-instead).

## Quick start

```bash
cp .env.example .env       # defaults are fine to start
cd server
npm install
npm start
```

Then open **http://localhost:4000**.

On first boot the server does an initial price fetch automatically (no
need to wait for the daily cron job), then re-fetches once a day at the
time set by `REFRESH_CRON` in `.env`. You can also click **Refresh now**
in the UI, or `POST /api/price-tracker/refresh`, to fetch on demand.

### Try it without network access

Set `PRICE_PROVIDER=mock` in `.env` to run entirely on deterministic sample
data (10 sample cards with 40 days of synthetic price history, no network
calls). Useful for local development, demos, or if tcgcsv.com is ever
unreachable.

## How price history works

Each refresh stores one price snapshot per tracked card for that day in
`server/data/db.json`. "% change over the last month" compares today's
snapshot to the snapshot closest to (today − `LOOKBACK_DAYS`, default 30).

**On a brand-new install (real `tcgcsv` provider), that comparison has
nothing to compare against yet** — cards will show "collecting history"
until ~30 daily refreshes have accumulated. This is intentional: the
current implementation only stores prices it has actually observed, rather
than guessing at tcgcsv.com's historical-archive file format (it does
publish a daily archive back to Feb 2024 at tcgcsv.com/docs — worth wiring
up as a one-time backfill if you want alerts from day one; left as a
follow-up since the archive's exact layout should be checked against the
current docs, which weren't reachable from this dev environment). The
`mock` provider backfills 40 days of synthetic history immediately so you
can see full functionality without waiting.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `PRICE_PROVIDER` | `tcgcsv` | `tcgcsv` (live data) or `mock` (offline demo data) |
| `ALERT_MIN_PRICE` | `4` | Minimum current price to be alert-eligible |
| `ALERT_PCT_CHANGE` | `20` | Minimum absolute % move to alert on |
| `LOOKBACK_DAYS` | `30` | Comparison window |
| `WATCHLIST_MODE` | `all-sets` | `all-sets`, `recent-sets`, or `named-sets` |
| `RECENT_SET_COUNT` | `8` | Sets tracked when mode is `recent-sets` |
| `WATCHLIST_SET_NAMES` | *(empty)* | Comma-separated set names when mode is `named-sets` |
| `REFRESH_CRON` | `0 13 * * *` | Daily refresh schedule (UTC, cron syntax) |
| `ONEPIECE_CATEGORY_ID` | *(empty)* | Optional: skip the category lookup by hardcoding tcgcsv's One Piece categoryId |

`all-sets` (the default) tracks every group tcgcsv.com has for the category
— currently around 90, spanning mainline boosters (100-180+ cards each),
starter/structure decks, and release-event bonus packs, so expect several
thousand cards total and a refresh that takes a couple of minutes rather
than seconds. `recent-sets` is a faster, narrower alternative, but note
tcgcsv weighs a small 11-card starter deck the same as a full booster when
ranking by recency - a low `RECENT_SET_COUNT` can end up dominated by
whatever small decks shipped most recently instead of covering more
boosters. Use `GET /api/price-tracker/debug/fetch-summary` after a refresh
to see exactly which groups were picked and their product/price counts.

## Using the official TCGPlayer API instead

If you have `client_id`/`client_secret` credentials from an existing
TCGPlayer API partnership, add a new provider next to
`server/src/modules/price-tracker/providers/tcgcsvProvider.js` that
implements the same `fetchWatchlistPrices(watchlistConfig)` contract
(documented in `providers/provider.js`), register it in `providers/index.js`,
and set `PRICE_PROVIDER` to its key. The official endpoints
(`/catalog/categories`, `/catalog/categories/:id/groups`,
`/catalog/products`, `/pricing/product/:ids`) return equivalent data —
tcgcsv.com is literally a cache of those same responses.

## Architecture

```
.
├─ server/
│  └─ src/
│     ├─ modules/
│     │  └─ price-tracker/        ← this module
│     │     ├─ providers/         ← pluggable price data sources
│     │     ├─ priceService.js    ← fetch → snapshot → alert math
│     │     ├─ alerts.js          ← threshold logic
│     │     └─ routes.js          ← /api/price-tracker/*
│     ├─ db.js                    ← JSON-file storage
│     ├─ scheduler.js             ← daily cron refresh
│     └─ app.js / index.js
└─ public/                        ← static dashboard (vanilla HTML/CSS/JS)
```

Each module owns its own `/api/<module-name>` route namespace and its own
folder under `src/modules/`. When the event tracker is built, it should
follow the same pattern (`src/modules/event-tracker/`, mounted at
`/api/event-tracker`) and get its own tab in `public/index.html` next to
the current disabled "Event Tracker — soon" placeholder — the nav and
server are already structured for that.

Storage is a flat JSON file (`server/data/db.json`), rewritten in full on
every debounced save. That's fine at `recent-sets` scale (a few hundred
cards), but with the `all-sets` default (several thousand cards, one
snapshot/day each) the file will grow into the tens of MB over a year and
every save gets a bit slower - acceptable for a hobby project, but if the
event tracker needs relational data anyway (registrations, standings,
etc.), that's a natural point to move both onto a real database. `db.js`
is the only file that would need to change for the price tracker to move
with it.

## API

| Endpoint | Description |
|---|---|
| `GET /api/price-tracker/status` | Provider, thresholds, counts, last refresh time |
| `GET /api/price-tracker/cards?alertsOnly=true&sort=pctChange\|price\|name\|color\|set&color=&setCode=` | Card list with computed price-change/alert fields, filterable by color/setCode |
| `GET /api/price-tracker/facets` | Distinct colors and sets actually present in the tracked cards (for populating filter dropdowns) |
| `GET /api/price-tracker/cards/:productId/history` | Full daily price history for one card |
| `POST /api/price-tracker/refresh` | Trigger an immediate price fetch |
| `GET /api/price-tracker/debug/fetch-summary` | Per-set breakdown from the last refresh: products found vs. matched vs. skipped (tcgcsv provider only) |
| `GET /api/price-tracker/debug/sample-product` | One raw, untransformed product+price record straight from tcgcsv.com, for inspecting its actual field shape (tcgcsv provider only) |
