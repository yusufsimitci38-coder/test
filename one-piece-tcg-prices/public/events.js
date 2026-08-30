const EVENT_API = '/api/event-tracker';

const evEl = {
  statusText: document.getElementById('event-status-text'),
  refreshBtn: document.getElementById('event-refresh-btn'),
  grid: document.getElementById('calendar-grid'),
  monthLabel: document.getElementById('cal-month-label'),
  prevBtn: document.getElementById('cal-prev'),
  nextBtn: document.getElementById('cal-next'),
  todayBtn: document.getElementById('cal-today'),
  dayDetail: document.getElementById('day-detail'),
  dayDetailTitle: document.getElementById('day-detail-title'),
  dayDetailList: document.getElementById('day-detail-list'),
  regWindowsList: document.getElementById('reg-windows-list'),
};

let currentMonth = new Date(); // day-of-month is irrelevant, only year/month used
let eventsLoadedOnce = false;

async function fetchJsonEv(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${url} -> HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadEventStatus() {
  try {
    const status = await fetchJsonEv(`${EVENT_API}/status`);
    evEl.statusText.textContent =
      `Provider: ${status.provider} · ${status.eventCount} events tracked · ` +
      `last refreshed ${status.lastRefreshAt ? new Date(status.lastRefreshAt).toLocaleString() : 'never'}`;
  } catch (err) {
    console.error('Failed to load event status:', err);
    evEl.statusText.textContent = `Couldn't reach the server (${err.message}). Check server logs.`;
  }
}

async function loadCalendar() {
  evEl.monthLabel.textContent = currentMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  evEl.grid.innerHTML = '<p class="empty-state">Loading events…</p>';
  evEl.dayDetail.hidden = true;

  let events;
  try {
    events = await fetchJsonEv(`${EVENT_API}/events?month=${monthKey(currentMonth)}`);
  } catch (err) {
    console.error('Failed to load events:', err);
    evEl.grid.innerHTML = `<p class="empty-state">Couldn't load events: ${err.message}<br />Check the server logs, or try "Refresh now".</p>`;
    return;
  }

  renderGrid(events);
}

function renderGrid(events) {
  const byDay = new Map(); // 'YYYY-MM-DD' -> event[]
  for (const e of events) {
    if (!e.date) continue;
    const day = e.date.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const startWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
    (wd) => `<div class="cal-weekday">${wd}</div>`
  );

  for (let i = 0; i < startWeekday; i += 1) {
    cells.push('<div class="cal-cell cal-empty"></div>');
  }

  const MAX_VISIBLE = 3;
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayEvents = byDay.get(dayStr) || [];
    const pills = dayEvents
      .slice(0, MAX_VISIBLE)
      .map(
        (e) =>
          `<div class="cal-event" title="${escapeHtml(e.location || '')}">${escapeHtml(e.name)}</div>`
      )
      .join('');
    const more = dayEvents.length > MAX_VISIBLE ? `<div class="cal-more">+${dayEvents.length - MAX_VISIBLE} more</div>` : '';
    const classes = ['cal-cell'];
    if (dayStr === todayStr) classes.push('cal-today');
    if (dayEvents.length) classes.push('cal-has-events');
    cells.push(
      `<div class="${classes.join(' ')}" data-day="${dayStr}"><div class="cal-daynum">${d}</div>${pills}${more}</div>`
    );
  }

  // Pad the final week out to a full 7 columns so the grid's own background
  // doesn't peek through an incomplete last row.
  while (cells.length % 7 !== 0) {
    cells.push('<div class="cal-cell cal-empty"></div>');
  }

  evEl.grid.innerHTML = cells.join('');

  evEl.grid.querySelectorAll('.cal-cell[data-day]').forEach((cell) => {
    cell.addEventListener('click', () => showDayDetail(cell.dataset.day, byDay.get(cell.dataset.day) || []));
  });
}

function showDayDetail(dayStr, events) {
  if (!events.length) {
    evEl.dayDetail.hidden = true;
    return;
  }
  evEl.dayDetail.hidden = false;
  evEl.dayDetailTitle.textContent = new Date(`${dayStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  evEl.dayDetailList.innerHTML = events
    .map((e) => {
      const time = e.date
        ? new Date(e.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : null;
      return `
        <li>
          <a href="${e.url || '#'}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.name)}</a>
          ${e.location ? `<p class="day-detail-location">📍 ${escapeHtml(e.location)}</p>` : ''}
          <div class="day-detail-meta">
            ${time ? `<span>${time}</span>` : ''}
            ${e.format ? `<span>${escapeHtml(e.format)}</span>` : ''}
            ${e.organizer ? `<span>${escapeHtml(e.organizer)}</span>` : ''}
            ${e.players != null ? `<span>${e.players} players</span>` : ''}
          </div>
        </li>
      `;
    })
    .join('');
}

async function loadRegistrationWindows() {
  try {
    const data = await fetchJsonEv(`${EVENT_API}/registration-windows`);
    const windows = data.windows || [];
    if (!windows.length) {
      evEl.regWindowsList.innerHTML =
        '<p class="empty-state">None found yet — check back after the next refresh, or verify directly on the official page above.</p>';
      return;
    }
    evEl.regWindowsList.innerHTML = `
      <table class="reg-table">
        <thead><tr><th>Event month</th><th>Applications open</th><th>Season</th></tr></thead>
        <tbody>
          ${windows
            .map(
              (w) => `
            <tr>
              <td>${escapeHtml(w.eventMonth)}</td>
              <td>${escapeHtml(w.applicationOpensOn)}</td>
              <td><a href="${w.sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.season)}</a></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    console.error('Failed to load registration windows:', err);
    evEl.regWindowsList.innerHTML = `<p class="empty-state">Couldn't load registration windows: ${err.message}</p>`;
  }
}

async function refreshEvents() {
  evEl.refreshBtn.disabled = true;
  evEl.refreshBtn.textContent = 'Refreshing…';
  try {
    await fetch(`${EVENT_API}/refresh`, { method: 'POST' });
    await Promise.all([loadEventStatus(), loadCalendar(), loadRegistrationWindows()]);
  } catch (err) {
    console.error(err);
    alert('Refresh failed. Check the server logs.');
  } finally {
    evEl.refreshBtn.disabled = false;
    evEl.refreshBtn.textContent = 'Refresh now';
  }
}

function changeMonth(delta) {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + delta, 1);
  loadCalendar();
}

evEl.refreshBtn.addEventListener('click', refreshEvents);
evEl.prevBtn.addEventListener('click', () => changeMonth(-1));
evEl.nextBtn.addEventListener('click', () => changeMonth(1));
evEl.todayBtn.addEventListener('click', () => {
  currentMonth = new Date();
  loadCalendar();
});

// Loaded lazily the first time the Event Tracker tab is opened (see nav.js),
// so viewing prices never triggers an event-tracker request.
window.ensureEventsLoaded = function ensureEventsLoaded() {
  if (eventsLoadedOnce) return;
  eventsLoadedOnce = true;
  loadEventStatus();
  loadCalendar();
  loadRegistrationWindows();
};
