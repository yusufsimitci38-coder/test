// Deterministic sample data - no network access required. Useful for local
// development/demos, and as a fallback if play.limitlesstcg.com is ever
// unreachable. Dates are generated relative to "today" so the calendar
// always has something to show regardless of when this runs.

function daysFromNow(offset, hour = 18, minute = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Offsets are in days relative to today; a mix of past, present, and future
// so navigating the calendar back/forward shows something in each month.
const SAMPLE_EVENTS = [
  { id: 'mock-1', offset: -35, name: 'Treasure Cup - Mock Games (Weekly)', format: 'Standard', organizer: 'Mock Games', players: 18 },
  { id: 'mock-2', offset: -14, name: 'Online Regional Qualifier', format: 'Standard', organizer: 'RK9', players: 96 },
  { id: 'mock-3', offset: -2, name: 'Treasure Cup - Mock Games (Weekly)', format: 'Standard', organizer: 'Mock Games', players: 22 },
  { id: 'mock-4', offset: 5, name: 'Treasure Cup - Card Kingdom Mock', format: 'Standard', organizer: 'Card Kingdom Mock', players: 14 },
  { id: 'mock-5', offset: 12, name: 'Regional Championship - Mock City', format: 'Standard', organizer: 'Bandai', players: 256 },
  { id: 'mock-6', offset: 12, name: 'Regional Championship Side Event - Mock City', format: 'Standard', organizer: 'Bandai', players: 32 },
  { id: 'mock-7', offset: 26, name: 'Treasure Cup - Mock Games (Weekly)', format: 'Standard', organizer: 'Mock Games', players: 20 },
  { id: 'mock-8', offset: 48, name: 'Online Regional', format: 'Standard', organizer: 'RK9', players: 120 },
  { id: 'mock-9', offset: 70, name: 'World Championship Qualifier', format: 'Standard', organizer: 'Bandai', players: 400 },
];

async function fetchEvents() {
  return SAMPLE_EVENTS.map((e) => ({
    id: e.id,
    name: e.name,
    date: daysFromNow(e.offset),
    format: e.format,
    organizer: e.organizer,
    players: e.players,
    url: `https://play.limitlesstcg.com/tournament/${e.id}/details`,
  }));
}

module.exports = { fetchEvents };
