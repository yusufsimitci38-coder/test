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
a results database) - and fetched in that order (`upcoming` first): the
plain listing is a full historical archive with far more pages than we pull
(`PAST_MAX_PAGES` in `limitlessProvider.js` deliberately caps it small), and
paging through it can burn Limitless's rate limit on its own - confirmed
live, where a refresh capped out exactly at that page limit and the very
next request came back HTTP 429. Fetching `upcoming` first means a rate
limit hit later, while paging through history, no longer costs the one part
of this that can't be found anywhere else. `fetchJson()` also retries once
or twice on a 429 (honoring `Retry-After` if the response includes one,
otherwise a short exponential backoff) before giving up on that request.

Each event also gets a best-effort `location` (venue/city), fetched from a
separate per-tournament details lookup that the basic list doesn't include -
the exact endpoint path and field name aren't confirmed from this dev
environment (network-blocked from it too), so two plausible paths are tried
and whichever responds is reused for the rest of the refresh. Capped and
paced (`MAX_DETAIL_FETCHES`/`DETAIL_PACING_MS` in `limitlessProvider.js`) so
it can't make a refresh unboundedly slow; a failure here just leaves
`location` null for that event rather than breaking anything. Shown under
the event name in the day-detail panel and as a hover tooltip on its
calendar pill - the fastest way to tell apart same-day events that share a
generic name (e.g. two different cities' Regionals) at a glance.

Refreshes daily (`EVENT_REFRESH_CRON`, default offset 30 minutes after the
price refresh) plus an initial fetch on first boot, same pattern as the
price tracker. `EVENT_PROVIDER=mock` gives deterministic sample events
(dates generated relative to today) for local dev without network access.
`GET /api/event-tracker/debug/sample` returns a raw, untransformed sample
straight from Limitless - including a details-endpoint lookup on a real
tournament id - for checking its actual field shape.

### Second event source: TopDeck.gg (optional)

Limitless already merges its own `/tournaments/upcoming` listing (above),
but a Limitless tournament page typically isn't created until shortly
before the event happens - so far-out local tournaments can be genuinely
absent from it for weeks, not just hidden by a filter. Regionals are
already covered much further out via the
[Regional Registration Windows](#registration-windows) table below the
calendar (deliberately kept as its own separate section, since a Regional
is a different scale/style of event from a weekly local) - this second
source is about *locals and weeklies* specifically, run by stores that use
[TopDeck.gg](https://topdeck.gg)'s tournament software.
`server/src/modules/event-tracker/providers/topdeckProvider.js` merges its
tournaments into the same calendar via `mergeEvents.js`, which best-effort
de-dupes likely-same-event entries (same calendar day, plus either a
matching venue substring or ≥50% word overlap in the name) between the two
sources - errs toward keeping two entries rather than risking collapsing
two genuinely different events into one, since a wrongly-kept duplicate is
harmless but a wrongly-merged pair silently hides a real event. Where a
duplicate is found, whichever source is missing a field (location, players,
format, organizer) gets it filled in from the other - never overwrites a
value the primary source already had.

Opt-in and additive only: unset `TOPDECK_API_KEY` (a free key from
[topdeck.gg/developers](https://topdeck.gg/developers)) and this is skipped
entirely, with no error - nothing else depends on it. Everything about the
real request/response shape in `topdeckProvider.js` (the `game` filter
value, response envelope, field names, timestamp units) is a best-effort
reconstruction from TopDeck's docs page and search-indexed snippets of it,
same as Bandai's registration-window scraping - this sandbox's network
egress is blocked from `topdeck.gg` itself (confirmed by a direct probe,
even with a real key), so none of it is verified against a live response
yet. `GET /api/event-tracker/debug/topdeck-sample` returns the raw
request/response (or error) once `TOPDECK_API_KEY` is set, for correcting
those guesses against real evidence.

### Region filter (English-speaking events)

Each event and registration window also gets a best-effort `isEnglishSpeaking`
flag (`server/src/modules/event-tracker/regionClassifier.js`), computed from
its name/location text against a small curated list of English-speaking vs.
non-English-speaking country names. There's no authoritative source for this,
so it defaults to `true` (visible) for anything ambiguous or missing location
data - the "Show non-English-speaking events & windows" checkbox on the Event
Tracker tab can only ever *hide* entries it's reasonably confident about,
never silently hide ones it just lacks good location data for. The checkbox
is a client-side toggle only: all events and windows are always fetched and
stored regardless of its state, so switching it just re-renders from the data
already in the browser (no extra request).

### Registration windows

No third-party source publishes these at all - checked RK9, TopDeck.gg,
gumgum.gg, and OPlayTCG; a paid wrapper called Parse.bot exists specifically
*because* `en.onepiece-cardgame.com` "does not publish a public developer
API or documented data feed." So this is scraped, best-effort, straight from
Bandai's own regional-season pages
(`server/src/modules/event-tracker/bandaiRegistration.js`) and shown as a
table under the calendar, sorted chronologically by event date.

Which season pages to scrape isn't hardcoded to today's seasons: every
refresh, `discoverSeasonPages()` first fetches the site's own events index
page (`en.onepiece-cardgame.com/events/`) and scrapes it for links matching
the season-page URL pattern (`regional-season<N>-<YY>-<YY>.html`) - so when
Bandai publishes 2027-28's season pages, they're picked up automatically the
next time this refreshes, with no code change needed. `FALLBACK_SEASON_PAGES`
(today's two known season URLs, hardcoded) is used only if that discovery
fetch fails outright or the index page has no matching links - the same
fail-safe pattern as everything else here, never a crash. The discovery
result (what it found, or why it fell back) is included as the first entry
in `GET /api/event-tracker/debug/bandai-raw`'s response, for checking it
against the live site.

Confirmed against the real page (via the debug endpoint below, checked
against the live deployment): under "Event Schedule and Tournament
Organizer", each region (North America / Europe / Oceania / Latin America)
lists its own Regionals as "`<Organizer>` Date: `<range>` Venue: `<address>`
Link: `<registration URL>`" - so each row gets an exact venue and a direct
registration link, not just a region name. A separate "Application Period"
section gives the date each event month's registration opens (e.g. "For
March Events: Starts December 28, 2025") plus a guideline time-of-day per
region (e.g. "North America: 9:00am PT / 12:00pm ET") - the page itself
flags this time as a guideline only, since the exact time is set by each
third-party tournament organizer, which is why every row also links straight
to that organizer's own registration page to confirm it. Each row's
`isEnglishSpeaking` (see [Region filter](#region-filter-english-speaking-events)
above) is computed from its venue text specifically, not the broader region
name - "Latin America"/"North America" both contain the substring "america",
which would otherwise false-positive-match the English-speaking marker list
before a Mexico or Brazil venue is ever checked.

This is meaningfully more fragile than the JSON-based providers: it depends
on regexing plain text extracted from the page rather than a stable API
contract, so a Bandai site redesign or wording change can silently break
extraction (it fails safe - an empty table, not a crash; a failure here
never blocks the regular event refresh). `GET /api/event-tracker/debug/bandai-raw`
returns the actual extracted plain text from each season page (plus what
got parsed out of it), which is the fastest way to fix the regex in
`bandaiRegistration.js` if Bandai's actual wording turns out to differ
from what it currently expects. It also returns a `debugSample` - the same
page, but with table row/cell boundaries (`@@ROW@@`/`@@CELL@@`) and link
targets (`@@LINK:href@@`) marked inline - for figuring out the real page
structure when the plain-text extraction alone isn't enough to tell.

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
| `GET /api/event-tracker/debug/topdeck-sample` | Raw TopDeck.gg request/response (or error), for checking its actual field shape once `TOPDECK_API_KEY` is set - see [Second event source: TopDeck.gg](#second-event-source-topdeckgg-optional) |
| `GET /api/event-tracker/registration-windows` | Every upcoming Regional Championship with venue, computed registration-open date, and a direct registration link - see [Registration windows](#registration-windows) |
| `GET /api/event-tracker/debug/bandai-raw` | Raw plain text extracted from Bandai's regional-season pages, plus what got parsed out of it - the fastest way to fix the scraper if it stops matching |
