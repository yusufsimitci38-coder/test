// Best-effort, NOT authoritative: classifies a free-text location/region
// string as English-speaking or not, by substring match against a small
// curated list. Anything not confidently matched - including missing
// location data, or "Online" - is treated as English-speaking by default,
// so the UI filter only ever hides entries we're reasonably sure about,
// rather than silently hiding ones we just lack good location data for.

const ENGLISH_SPEAKING_MARKERS = [
  'usa', 'u.s.a', 'u.s.', 'united states', 'america',
  'canada',
  'united kingdom', 'u.k.', 'england', 'scotland', 'wales', 'northern ireland', 'great britain',
  'australia',
  'new zealand',
  'ireland',
];

const NON_ENGLISH_MARKERS = [
  'japan', 'nippon',
  'mexico', 'méxico',
  'brazil', 'brasil',
  'germany', 'deutschland',
  'france',
  'spain', 'españa',
  'italy', 'italia',
  'netherlands', 'holland',
  'south korea', 'korea',
  'taiwan',
  'china',
  'thailand',
  'indonesia',
  'philippines',
  'vietnam',
  'poland',
  'portugal',
  'argentina', 'chile', 'colombia', 'peru',
  'sweden', 'norway', 'denmark', 'finland',
  'belgium', 'switzerland', 'austria',
  'czech', 'hungary', 'romania', 'bulgaria',
  'croatia', 'slovenia', 'slovakia', 'serbia', 'greece',
  'estonia', 'latvia', 'lithuania', 'ukraine',
  'russia',
  'turkey',
  'saudi arabia', 'uae', 'united arab emirates',
  'singapore', 'malaysia',
];

function isEnglishSpeaking(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  if (lower.includes('online')) return true;
  if (ENGLISH_SPEAKING_MARKERS.some((m) => lower.includes(m))) return true;
  if (NON_ENGLISH_MARKERS.some((m) => lower.includes(m))) return false;
  return true;
}

module.exports = { isEnglishSpeaking };
