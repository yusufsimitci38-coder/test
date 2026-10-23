# One Piece TCG Toolkit

Three modules sharing one server and dashboard (see [Architecture](#architecture)):

- **Price Tracker** — tracks TCGPlayer market prices for One Piece Card
  Game singles and flags cards that have moved a lot recently: **price ≥ $4
  and a ≥ 20% change over the trailing 30 days** (both thresholds are
  configurable).
- **Event Tracker** — a calendar of One Piece TCG tournaments (Regionals,
  Treasure Cups, online events) pulled from Limitless TCG's public data.
- **Lethal Calculator** — plans out one turn's attacks and tells you whether
  it's lethal, accounting for Double Attack, Banish, Blocker, and DON!! -
  see [Lethal Calculator](#lethal-calculator) below.

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
| `MIN_DISPLAY_PRICE` | `2` | Display-only floor: cards priced below this are hidden from the card list entirely (independent of `ALERT_MIN_PRICE` - a card can be shown but never alert-eligible, and cards below this floor are hidden regardless of alert status). A card with no price yet is never hidden by this. |
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

## Favorites

Click the ☆ on any card (Price Tracker or Favorites itself) to star it; a
separate **Favorites** tab shows only starred cards, with the same sort
options as the main grid. Stored server-side (`favorites` in the data
file, keyed by productId) rather than in the browser, so it shows up the
same way from any device hitting this deployment - see
[Persistence across redeploys](#persistence-across-redeploys) above for why
that means setting `DATA_DIR` to a mounted volume matters more here than
for prices/events: a lost favorite can't be re-fetched from a source the
way cached price/event data can, it just has to be re-starred by hand.

Favoriting bypasses `MIN_DISPLAY_PRICE` - a card you've explicitly starred
never disappears from the Favorites tab just because it's currently priced
below that floor, even though it wouldn't show up in the main grid on its
own. `GET /api/price-tracker/cards?favoritesOnly=true` is the underlying
endpoint (composable with the same `sort`/`color`/`setCode` params as the
main list); `PUT`/`DELETE /api/price-tracker/favorites/:productId` toggle
one card.

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
entirely, with no error - nothing else depends on it.

This sandbox's network egress is blocked from `topdeck.gg` itself (even
with a real key), so the request/response shape in `topdeckProvider.js` was
worked out entirely via `GET /api/event-tracker/debug/topdeck-sample`
against the live API once a real key was available - the same
debug-endpoint-plus-real-evidence pattern used for Limitless's detail
endpoint and Bandai's registration-window scraping, just with more rounds
of it. Confirmed the hard way: the request body requires **both** `game`
*and* `format` - sending only `game` (as the first version of this file
did) gets rejected outright with HTTP 400, which silently zeroed out the
entire integration until caught. `game: "One Piece"` and `format:
"Standard"` are both confirmed correct now. Per-tournament field names also
turned out to differ from the initial guesses in a few places - notably
`TID` (that exact casing) for the id, `tournamentName` for the name, and
location nested under `eventData.address` rather than any top-level field -
all fixed to match. Also worth knowing: `start` is a plain
`startDate >= start` filter, not something that defaults to
future-dated tournaments - a real response with `start=0` returned a
*completed* tournament (full standings/decklists), so whether TopDeck has
anything genuinely upcoming for One Piece at a given moment will vary. The
debug endpoint accepts `?game=`/`?format=`/`?start=`/`?omitGame=1`
overrides for testing candidate values directly against the live API
without a redeploy per guess, which is how all of the above got nailed
down - worth reaching for again if TopDeck's shape ever drifts.

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

## Lethal Calculator

Entirely client-side (`public/lethal.js`) - no server route, nothing
persisted. Unlike the other two modules, there's no external data source or
history to track: it's a pure "plan this turn's attacks, right now" tool,
so it just runs in the browser against whatever you type in.

Enter the opponent's Leader power, current Life, and how many active
Blockers they have; your Leader and each Character that can actually
attack this turn (power, Double Attack, Banish). Every attacker is simply
configured as attacking the Leader - there's no per-attacker "which
Blocker intercepts this" assignment, because that's not the attacker's
decision to make. Declaring a Blocker is the DEFENDER's choice, made in
response to each attack, using whichever active Blocker they still have;
a Blocker's name and power don't affect whether the turn is lethal either
(blocking fully prevents Life loss regardless of the power comparison), so
only a count is asked for - see "Blocking" below for how it's used. That
count is capped at 5, same reasoning and same limit as the attacker side
below: the Character Area only has 5 slots, so the defender can never have
more than 5 active Blockers either. "+ Add Attacking Character" stops at 5
- the Character Area only has 5 slots, so the Leader plus 5 Characters (6
attackers) is the legal maximum a real board can ever have, and the button
disables itself there rather than letting the tool describe an impossible
board. There's no attack-order
control either (no more ↑/↓ buttons) - just list who's on board, and the
calculator searches the order to attack in too, alongside
the DON!! split - see "Attack order search" below for why that's not just
set-dressing and what it costs to search.

**Interface:** every numeric field (power, Life, DON!!, deck counts, Active
Blockers) is a stepper with -/+ buttons instead of a bare `<input
type="number">`; Life is a row of tap-to-set chips that fill up together
like a life-total meter; the DON!! pool and Active Blockers counts are
additionally shown as small diamond tokens so the pool reads at a glance
(Blockers' tokens are blue, DON!!'s are the usual accent red, so the two
resources aren't confused); and Double Attack/Banish/"Attacks this turn"
are tap-to-toggle pills rather than checkboxes. None of this changes
what's actually submitted - every widget just writes back to the same
underlying input and fires the same `input` event a real keystroke would,
so the calculation code below never knows the difference. Each attacker
row in "Your Board" also picks up a thin left-border accent color, cycled
by its stable ROSTER position - not by where a given line ends up
attacking it, which the search can now change - the same way the results
view colors its sequence tiles (`attackerAccent()`/`refreshAttackerAccents()`),
kept in sync on every add, remove, and the Leader's "Attacks this turn"
toggle (the only thing that can shift Characters' roster indices). A
tile's color always matches its attacker's board row, so a line's sequence
reads as "these specific attackers, in this order" even when two different
lines attack in different orders. Results are shown the same way: the top
line gets a percent ring, a "BEST LINE"/"CLOSEST LINE" badge, and a compact
sequence of power tiles (one per attacker, in that line's chosen attack
order, consistently colored by identity) showing both the DON!! split and
the order at a glance, with the full play-by-play tucked into a
collapsible section beneath it; every other explored line gets one compact
row - percent, a small progress bar, and its own sequence tiles - that
expands into its own play-by-play on click.

**DON!! allocation search:** a player's total DON!! this turn can never
exceed 10 - that's the entire DON!! deck - so "Total DON!! available this
turn" is capped at 10. Instead of fixing a DON!! amount per attacker and
re-running one scenario at a time, enter your total pool for the turn
(e.g. 7) and the calculator enumerates every way to split that pool across
your attackers (each row's optional "Max DON" caps how much a specific
attacker could legally receive), runs the combat math on each split, and
scores every split that's lethal at all with a real percentage (see
"Lethal percentage" below). The split with the highest percentage - ties
broken toward using MORE of the pool, not less - is the recommended line,
with a handful of others shown alongside it. Giving an attacker extra
DON!! can only raise (never lower) a line's percentage, since it strictly
raises the Counter cost needed to negate that battle, so this tie-break is
exactly "spend all available DON!! whenever it doesn't hurt the chance of
lethal" - every full-pool split is already enumerated and scored, the
tie-break just stops a leftover, no-better partial split from edging it
out. This search doesn't need a FULL order search of its own: even whether
a split is lethal at all (no Blocker/Counter assumed - the base case this
search filters on) can depend on order, since a Double Attack landing LAST
can waste its second hit against an opponent who's already at 0 Life (see
"Double Attack" above) - but the best possible order for exactly that
question has a simple, cheap, provably-correct shortcut: put whichever
battle has the FEWEST hits last (an exchange argument - swapping any other
battle into last place can only reduce the hits already dealt before it).
`buildBattles()` always arranges a distribution's battles that way, so this
filtering step stays a single cheap pass per distribution rather than
needing n! tries. Order matters MORE once the defender gets to make real
block/Counter choices against it, though - see "Attack order search" just
below - so that gets its own, separate, bounded search pass, after this
one, over just the lines this search already found worth scoring. This
search is exhaustive, not an
approximation, for any legal board: with the pool capped at 10 and at most
6 attackers (1 Leader + 5 Characters - the Character Area's real limit, now
enforced by the "+ Add Attacking Character" button itself), splitting the
pool across them has C(16,6) = 8,008 possibilities at most - trivial next
to the 1,000,000-split cap. That cap is sized for far more than any real
board needs (up to 13 attackers, impossible in a legal game, would still
fit under it) purely as a safety margin, not because this search was ever
meant to be approximate (an earlier, much lower cap genuinely was - see the
commit history for the bug it caused and how the fix was verified).

**Attack order search:** a battle that's allowed to CONNECT early can fund
Countering a pricier one later (see "Assumed Counter budget" below for the
mid-turn hand-growth mechanic that makes this true), so the SAME set of
battles can be survivable in one order and lethal in another - this is a
real effect, not a simplification, confirmed with a constructed two-battle
example (one cheap to Counter, one expensive, a Counter budget that can't
afford either up front but can afford the cheap one after the other
connects) where attacking in one order is 0% and the other is 100%, same
inputs otherwise. Trying every order against the full Monte Carlo check
(`TRIAL_COUNT` samples) for every DON!! split the search above finds would
be exhaustive but is computationally far too expensive (tens of millions
of checks even for a 7-attacker board), so this runs as a bounded second
pass instead: for the best few DON!! splits already scored (budgeted by
total solver calls, not a fixed candidate count, since a candidate's own
attacker count sets its own cost - see `ORDER_SEARCH_CALL_BUDGET` in
`lethal.js`), it tries reordering their battles, using ONE quick solver
call per candidate order against the single average-resource estimate
(the same numbers behind the live "Quick estimate" preview) to find a
promising reordering cheaply, then - critically - confirms that candidate
actually scores HIGHER under the real Monte Carlo check before ever
adopting it. A bad guess from the cheap pass just gets discarded, so this
can only ever improve a line's percentage, never make it worse than
leaving its battles in buildBattles()'s own default order (fewest hits
last - see "Double Attack" above). Bounded at 8! = 40,320 orders; below
that cutoff this is exhaustive, not a heuristic. With the 5-Character cap
above, a line can have at most 6 attackers (6! = 720 orders) - well inside
that bound - so in practice this pass is ALWAYS exhaustive for any legal
board; the 40,320 cutoff exists only as a safety margin, not because a real
board can reach it. The order a line settles on is exactly what's shown in
its results - its sequence tiles and its play-by-play log both narrate in
that attack order.

**Blocking:** since blocking an attack costs the defender nothing (no
Life lost either way in this tool, regardless of the power comparison), a
rational defender always prefers a free Blocker over spending Counter on
the same attack - but with a LIMITED number of Blockers and a limited
Counter budget competing for the same battles, *which* attacks get
blocked and which get Countered genuinely matters. A simple "block the
biggest hits first" rule gets this wrong in some cases: blocking the
attack that's *cheapest* to Counter can strand an *expensive* one the
budget can't cover, when blocking the expensive one and Countering the
cheap one would have survived. The DP in `defenderCanSurvive()` solves
this exactly, as a third option per battle alongside Counter/connect (see
"Assumed Counter budget" below) - verified against a brute-force search
over every block/Counter/connect assignment across 20,000 randomized
battle/budget/Blocker combinations, with zero mismatches.

The percentage already accounts for this optimal blocking (and Countering)
- but the "Full play-by-play for this line" log shown under each result
does NOT, by design: it's the line's raw attack order and hit count,
checked AS IF the opponent played no Blocker or Counter at all, which is
also what the DON!! search scores as "base lethal" before the Monte Carlo
step even runs. The log says so inline now, since showing every hit
connecting there (even with Blockers available) previously read as the
calculator ignoring them, when it's really just not the thing that log is
for.

The combat math is grounded in the official Comprehensive Rules (confirmed
via a mix of the rules PDF and corroborating community guides - this
sandbox can't fetch `en.onepiece-cardgame.com` directly, same as everywhere
else in this project that cites it):

- **Battle:** attacker power ≥ defender power wins (ties go to the
  attacker); losing a battle never penalizes the attacker itself.
- **Blocker:** redirects one attack fully away from the Leader; can only
  block once per turn.
- **DON!!:** each attached DON!! is +1000 power, for the turn only.
- **Double Attack:** *not* "2x power" - it deals damage as two separate
  Life-card hits, each its own reveal/Trigger opportunity, but each hit
  only takes a Life card if one is actually left. **A Double Attack cannot
  win the game on its own against a 1-Life opponent** - the official
  Comprehensive Rules FAQ is explicit about this (Double Attack 4-10/4-11):
  if the first hit takes the last Life card, the second hit has nothing to
  take and simply does nothing, Trigger included. This isn't a
  simplification - it changed a real bug in an earlier version of this tool
  (and session), where a flat hit-count sum made a Double Attack landing
  on low Life look lethal when it wasn't - see "Loss condition" just below
  for why this makes attack ORDER matter even for whether a line is lethal
  at all, not just for the Counter/Blocker interaction.
- **Banish:** the Life card removed goes straight to the trash, unseen - no
  Trigger, ever, for that specific hit.
- **Loss condition:** reaching 0 Life isn't itself a loss - the player
  loses when they're attacked WHILE ALREADY at 0 Life. Critically, this is
  checked once per BATTLE, before that battle's damage is dealt - not once
  per individual hit within one multi-hit battle. So a Double Attack that
  brings Life from 1 to 0 doesn't lose the game on its own hit count (see
  above) - but a battle that STARTS once Life is already 0, whether it's a
  single hit or another Double Attack, does. This means a Double Attack
  landing LAST in a sequence can waste its second hit for nothing, while
  the exact same battles with it landing FIRST instead (so something else
  lands the final blow once Life is already 0) can be lethal - the order
  genuinely changes the answer, which is exactly what the search described
  below accounts for.

These are exactly the two factors the request that prompted this page
called out as missing from existing public lethal calculators (Double
Attack, Banish), plus the other keyword interactions (Blocker, DON!!, K.O.)
needed for the math to be meaningful at all.

**Assumed Counter budget:** instead of typing a guessed Counter value per
attack, enter the opponent's hand size plus how many 1000- and 2000-power
Counter cards their deck runs (defaults: 14 and 11, out of a 50-card deck -
the typical range is 12-16 and 10-12). The calculator averages that deck
composition into an assumed Counter value per card, multiplies by hand size,
and rounds to the nearest 1000 to get a total Counter budget for the turn -
e.g. the defaults give ≈780/card, so a 5-card hand assumes ≈3,900 available.
Blocking and Countering are the two things that can stop an attack, and
since every attack targets the Leader in this tool (see "Blocking" above),
Counter only ever needs to be weighed against that same Leader-bound
threat - there's no separate "Counter spent defending a Blocker" case to
account for.

That budget isn't static through the turn, either. Per the official Q&A and
printed [Banish] card text, a Life card dealt as damage is added to the
defender's hand unless it's Banished - unconditionally otherwise, whether or
not its [Trigger] is activated - and Counter has no "must have been in hand
since the start of the turn" restriction (an official Counter Event that
itself adds a Life card to hand confirms cards reaching hand mid-turn and
then being played is an intended pattern, not an edge case). So a card
gained from an *earlier* battle's damage this turn is fair game to Counter a
*later* battle in the same sequence - exactly like DON!!, it's one shared
pool spent down across every Leader hit, not a fresh value per battle, but
unlike DON!! it can also grow mid-turn, using the deck's average Counter
value per card (see "Lethal percentage" below for why this one part stays
an average rather than a full sample). For each DON!! split in the search,
the calculator checks every order of block/Counter/allow decisions across
that line's battles (Counter per battle is all-or-nothing - either it
fully negates the attack, or none is spent and it connects in full,
growing the budget for what comes next) to see whether the defender
survives a given sample of resources.

**Lethal percentage:** rather than one average-based point estimate of the
opponent's Counter and healing resources, each line is scored by actually
sampling the hidden information: thousands of random hands and Life piles,
drawn from the deck composition entered below (hand size, 1000-/2000-power
Counter cards, Counter Events, Yellow's heal count, deck size), each
checked for survival with the exact same solver described above - just fed
that sample's real resources instead of the average. The percentage shown
is the share of those simulated hands where the defender couldn't survive -
a genuine Monte Carlo estimate (2,000 samples per line), not a guess. DON!!
and Blocker counts are read directly rather than sampled, since those are
known board state the user can see, not hidden information. A quick,
instant, average-based estimate is still shown live while typing (before
clicking "Find Lethal Lines") as a rough preview, but the percentage next
to each result is the rigorous version.

What's still approximated, even in the percentage: the mid-sequence
hand-growth amount uses the deck's average Counter value rather than a
fully re-sampled draw (see above); the discard cost for Red's Event and
Yellow's heal is assumed to come from non-Counter-value cards whenever
possible, falling back to not using that Event/heal rather than sacrificing
a Counter card if there aren't enough (see `sampleDefenderResources()`);
and generic Trigger effects beyond Yellow's heal-on-Trigger still aren't
modeled - what an un-Banished Life card does if revealed needs rules only a
user can supply.

**Color-specific Counter Events:** the opponent's Leader color (plus an
optional secondary color, for dual-color Leaders) and how much DON!! is
available to them now feed into the Assumed Counter math for Red, Yellow,
and Purple, each described by the user and implemented as follows. A
Counter Event is a card played from hand for a specific effect instead of
a printed Counter value, and is a SEPARATE resource from the generic
1000/2000-value cards already averaged into the budget:

- **Universal (every color):** a 1-DON!!-cost Counter Event worth +4000
  power - 1 hand card plus 1 DON!!, bounded by however many such cards are
  assumed in the deck (default 3, typically 2-4) AND by DON!! actually
  available AND by having a hand card to spare. Purple decks typically run
  more of these (4-6) - there's no auto-adjustment for that, just a hint
  reminding you to bump the count if the opponent is Purple.
- **Red only:** a 0-DON!!-cost Counter Event worth +3000 power, at the cost
  of 2 hand cards (the event itself, plus discarding another card). Default
  count 3 (typically 2-4). Has no effect unless Leader color (primary or
  secondary) is Red.
- **Yellow only:** not a Counter Event at all - a specific Trigger variant.
  When one of these Life cards is dealt as damage, it's played instead of
  added to hand (so it doesn't feed the mid-turn hand-growth mechanic
  above), and the defender may discard 1 hand card to add 1 card from the
  top of their deck to their Life area - i.e. heal 1 Life. Estimated as
  (current Life × assumed count ÷ deck size), since Life cards are just the
  top of the same shuffled 50-card deck as everything else; default count 6
  (typically 4-8). Has no effect unless Leader color is Yellow.

All three compete for the SAME hand-card pool as generic Counter: hand
cards are spent on Events first (universal, then Red), and whatever's left
funds the generic average-value budget; Yellow's heal is capped by hand
size but NOT jointly optimized against the Events above - a deliberate
simplification, since exactly solving "spend this card on Counter now, or
save it to heal later" per battle would need a much larger search. This
tends to slightly overestimate total defense, which is the safer direction
for a lethal calculator to be wrong in.

**Deliberately left out:** Purple's Slow Slow Beam (2 DON!!, +2000 Counter,
and rests an enemy Character) isn't modeled. Unlike every other Counter
Event here, resting a Character can cancel a LATER attack in the line
outright rather than add defensive power to the current one - that doesn't
fit this calculator's "battles are fixed, only their Counter outcome is
searched" shape, and the user explicitly said to skip it rather than risk
getting it wrong. Dual-color Leaders get both of their colors' Events, but
no deeper two-color interactions are modeled yet.

**Blue and Black have no color-specific mechanic to model**, confirmed by
the user - Blue's larger boards and heavier Blocker count are already
captured by the Active Blockers count, not something this calculator needs
to assume on its own. **Green is the same
for now** - a Leader releasing in about a month is expected to let certain
cards count as 3000 Counter, but it isn't in the game yet, so there's
nothing to add until it releases.

`public/lethal.js` bundles every opponent-side input (Leader power, Life,
color, DON!! available, Blocker count, deck composition, Event counts) into
one `defender` context object via `readDefenderContext()`. `buildBattles()`
(per-attacker; its own output IS ordered, fewest-hits-last by default - see
"Double Attack" and "DON!! allocation search" above) and
`defenderCanSurvive()` are unchanged by the percentage feature - they're
run once per Monte Carlo sample, fed that sample's
`counterBudget`/`effectiveStartingLife` instead of the single average (see
`sampleDefenderResources()`, `buildDeckComposition()`, and
`estimateLethalPercent()`), so the same exact solver already described
above is what each of the thousands of samples is checked against, for
whichever order a line settled on (buildBattles()'s default order, or a reorder found by
`findBetterOrder()` - see "Attack order search").

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
   ├─ lethal.js                   ← lethal calculator (client-only, no server route)
   └─ nav.js                      ← tab switching between views
```

Each module owns its own `/api/<module-name>` route namespace and its own
folder under `src/modules/`, mounted the same way in `app.js` - a further
module would follow the same pattern. The Lethal Calculator is the
exception: it's pure client-side computation with no history to persist,
so it has no `src/modules/` folder or routes of its own - just `lethal.js`
and the markup/templates in `index.html`.

Storage is a flat JSON file (`server/data/db.json` by default, or
`$DATA_DIR/db.json` - see below), rewritten in full on every debounced
save. That's fine at `recent-sets` scale (a few hundred cards) or for the
event tracker's much smaller event list, but with the price tracker's
`all-sets` default (several thousand cards, one snapshot/day each) the file
will grow into the tens of MB over a year and every save gets a bit
slower - acceptable for a hobby project, but if a future module needs
relational data (e.g. structured registrations), that's a natural point to
move everything onto a real database. `db.js` is the only file that would
need to change for both modules to move with it.

### Persistence across redeploys

By default the data file lives inside the app's own directory tree, which
is fine for local dev but sits on an ephemeral container filesystem on a
host like Railway (without a mounted volume) - it gets wiped on every
redeploy (a code push, or even just adding/changing an env var), and the
app rebuilds it from scratch on next boot (price/event data re-fetches
automatically; anything that can't be re-fetched from a source, like
favorites, would just be gone).

Set `DATA_DIR` to a mounted persistent volume's path to fix this properly:
on Railway, add a Volume to the service (Settings → Volumes) with whatever
mount path you choose (e.g. `/data`), then set the `DATA_DIR` environment
variable to that same path. The data file (and everything in it) then
survives redeploys instead of resetting.

## API

| Endpoint | Description |
|---|---|
| `GET /api/price-tracker/status` | Provider, thresholds, counts, last refresh time |
| `GET /api/price-tracker/cards?alertsOnly=true&favoritesOnly=true&sort=pctChange\|weeklyChange\|dailyChange\|price\|name\|color\|set&color=&setCode=&page=1&pageSize=50` | Paginated card list: `{ cards, page, pageSize, totalCount, totalPages }`, with computed price-change/alert/favorite fields on each card, filterable by color/setCode. `page`/`pageSize` are clamped server-side (page to `[1, totalPages]`, pageSize to `[1, 200]`, default pageSize 50) rather than erroring on an out-of-range value. `pctChange` sorts by the 30-day (`LOOKBACK_DAYS`) move and is null - so effectively unsorted - for every card until that much history has actually been collected; `weeklyChange`/`dailyChange` sort by the 7-day/1-day move instead, which have real values much sooner. `favoritesOnly` bypasses `MIN_DISPLAY_PRICE` - see [Favorites](#favorites) |
| `PUT /api/price-tracker/favorites/:productId` | Mark a card as a favorite; returns its updated view, or 404 for an unknown productId |
| `DELETE /api/price-tracker/favorites/:productId` | Unmark a favorite |
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
