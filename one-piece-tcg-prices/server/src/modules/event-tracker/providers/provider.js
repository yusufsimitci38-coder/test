// Contract every event provider must implement.
//
// fetchEvents() resolves to an array of event records:
//   {
//     id: string,             // stable unique id from the source
//     name: string,
//     date: string | null,    // ISO 8601 timestamp of the event start
//     format: string | null,  // e.g. "Standard"
//     organizer: string | null,
//     players: number | null, // registered/participating player count, if known
//     url: string | null,     // link back to the event's page on the source site
//   }
//
// Registration/"application open" dates are deliberately NOT part of this
// contract: there is no clean structured source for them across organizers
// (see README) - each event's own page (via `url`) is the place to check.

module.exports = {};
