# One Piece TCG Toolkit

Two modules sharing one server and dashboard (see [Architecture](#architecture)):

- **Price Tracker** — tracks TCGPlayer market prices for One Piece Card
  Game singles and flags cards that have moved a lot recently: **price ≥ $4
  and a ≥ 20% change over the trailing 30 days** (both thresholds are
  configurable).
- **Event Tracker** — a calendar of One Piece TCG tournaments (Regionals,
  Treasure Cups, online events) pulled from Limitless TCG's public data.

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
| `REFRESH_CRON` | `0 13 * * *` | Daily price refresh schedule (UTC, cron syntax) |
| `ONEPIECE_CATEGORY_ID` | *(empty)* | Optional: skip the category lookup by hardcoding tcgcsv's One Piece categoryId |
| `EVENT_PROVIDER` | `limitless` | `limitless` (live data) or `mock` (offline demo data) |
| `EVENT_REFRESH_CRON` | `30 13 * * *` | Daily event refresh schedule (UTC, cron syntax) |

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

## Event Tracker

Pulls tournament data from **[Limitless TCG](https://onepiece.limitlesstcg.com)**'s
free, public, no-API-key tournament database (`play.limitlesstcg.com/api`,
filtered to `game=OP`), and shows it as a month calendar in the dashboard's
Event Tracker tab. Click a day with events to see the list; click an event
to open its page on Limitless. Both the plain listing and the site's
separate `/tournaments/upcoming` listing are fetched and merged, since the
plain one is biased toward already-*held* events (Limitless is fundamentally
a results database).

Refreshes daily (`EVENT_REFRESH_CRON`, default offset 30 minutes after the
price refresh) plus an initial fetch on first boot, same pattern as the
price tracker. `EVENT_PROVIDER=mock` gives deterministic sample events
(dates generated relative to today) for local dev without network access.
`GET /api/event-tracker/debug/sample` returns a raw, untransformed sample
straight from Limitless for checking its actual field shape.

### Registration/"application open" windows

No third-party source publishes these at all - checked RK9, TopDeck.gg,
gumgum.gg, and OPlayTCG; a paid wrapper called Parse.bot exists specifically
*because* `en.onepiece-cardgame.com` "does not publish a public developer
API or documented data feed." So this is scraped, best-effort, straight from
Bandai's own regional-season pages
(`server/src/modules/event-tracker/bandaiRegistration.js`) and shown as a
small table under the calendar - by event month, not per specific event,
since that's the granularity Bandai itself publishes this at.

This is meaningfully more fragile than the JSON-based providers: it depends
on regexing plain text extracted from the page rather than a stable API
contract, so a Bandai site redesign or wording change can silently break
extraction (it fails safe - an empty table, not a crash; a failure here
never blocks the regular event refresh). `GET /api/event-tracker/debug/bandai-raw`
returns the actual extracted plain text from each season page (plus what
got parsed out of it), which is the fastest way to fix the regex in
`bandaiRegistration.js` if Bandai's actual wording turns out to differ
from what it currently expects.

## Architecture

```
.
├─ server/
│  └─ src/
│     ├─ modules/
│     │  ├─ price-tracker/        ← price tracker module
│     │  │  ├─ providers/         ← pluggable price data sources
│     │  │  ├─ priceService.js    ← fetch → snapshot → alert math
│     │  │  ├─ alerts.js          ← threshold logic
│     │  │  └─ routes.js          ← /api/price-tracker/*
│     │  └─ event-tracker/        ← event tracker module
│     │     ├─ providers/         ← pluggable event data sources
│     │     ├─ eventService.js    ← fetch → store → month filtering
│     │     └─ routes.js          ← /api/event-tracker/*
│     ├─ db.js                    ← JSON-file storage
│     ├─ scheduler.js             ← daily cron refreshes
│     └─ app.js / index.js
└─ public/                        ← static dashboard (vanilla HTML/CSS/JS)
   ├─ app.js                      ← price tracker view
   ├─ events.js                   ← event tracker / calendar view
   └─ nav.js                      ← tab switching between the two
```

Each module owns its own `/api/<module-name>` route namespace and its own
folder under `src/modules/`, mounted the same way in `app.js` - a further
module would follow the same pattern.

Storage is a flat JSON file (`server/data/db.json`), rewritten in full on
every debounced save. That's fine at `recent-sets` scale (a few hundred
cards) or for the event tracker's much smaller event list, but with the
price tracker's `all-sets` default (several thousand cards, one
snapshot/day each) the file will grow into the tens of MB over a year and
every save gets a bit slower - acceptable for a hobby project, but if a
future module needs relational data (e.g. structured registrations), that's
a natural point to move everything onto a real database. `db.js` is the
only file that would need to change for both modules to move with it.

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
| `GET /api/price-tracker/debug/card/:productId` | A tracked card's stored data next to a fresh raw fetch of that same card, for checking a reported data mismatch against the source (tcgcsv provider only) |
| `GET /api/event-tracker/status` | Provider, event count, last refresh time |
| `GET /api/event-tracker/events?month=YYYY-MM` | Events in a given month, sorted chronologically (omit `month` for the full list) |
| `POST /api/event-tracker/refresh` | Trigger an immediate event fetch |
| `GET /api/event-tracker/debug/sample` | Raw, untransformed sample response straight from Limitless, for inspecting its actual field shape (limitless provider only) |
| `GET /api/event-tracker/registration-windows` | Scraped Regional Championship registration-open dates, by event month (best-effort - see [Registration/"application open" windows](#registrationapplication-open-windows)) |
| `GET /api/event-tracker/debug/bandai-raw` | Raw plain text extracted from Bandai's regional-season pages, plus what got parsed out of it - the fastest way to fix the scraper if it stops matching |
