// Best-effort merge of a secondary event source (e.g. TopDeck.gg) into the
// primary one (Limitless), de-duping likely-duplicate entries - the same
// real-world tournament reported to two different platforms, which have no
// shared id to match on. This is inherently approximate: it errs toward
// keeping distinct-looking events separate rather than risking collapsing
// two different real events into one, since a wrongly-merged pair silently
// hides a real event, while a wrongly-kept duplicate is just a harmless
// extra calendar entry.

const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'one', 'piece', 'card', 'game', 'tcg', 'op',
  'regional', 'regionals', 'championship', 'championships', 'cup',
  'tournament', 'tournaments', 'event', 'events', 'series',
]);

function nameWords(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w));
}

// Fraction of the smaller word set that's also in the larger one - robust
// to one name being a longer/shorter phrasing of the other (e.g. "Treasure
// Cup - Mock Games (Weekly)" vs "Mock Games Weekly Treasure Cup").
function wordOverlapScore(wordsA, wordsB) {
  if (!wordsA.length || !wordsB.length) return 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}

function sameVenue(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.includes(lb) || lb.includes(la);
}

const NAME_OVERLAP_THRESHOLD = 0.5;

function isLikelyDuplicate(a, b) {
  if (!a.date || !b.date) return false;
  if (a.date.slice(0, 10) !== b.date.slice(0, 10)) return false; // different calendar day
  if (sameVenue(a.location, b.location)) return true;
  return wordOverlapScore(nameWords(a.name), nameWords(b.name)) >= NAME_OVERLAP_THRESHOLD;
}

// Fills fields on `into` from `from` only where `into` doesn't already have
// a value - never overwrites data the primary source already provided.
function fillMissing(into, from) {
  for (const key of ['location', 'players', 'format', 'organizer']) {
    if (into[key] == null && from[key] != null) into[key] = from[key];
  }
  return into;
}

function mergeEvents(primary, secondary) {
  const merged = primary.map((e) => ({ ...e }));
  const extras = [];

  for (const s of secondary) {
    const match = merged.find((p) => isLikelyDuplicate(p, s));
    if (match) {
      fillMissing(match, s);
    } else {
      extras.push({ ...s });
    }
  }

  return [...merged, ...extras];
}

module.exports = { mergeEvents, isLikelyDuplicate };
