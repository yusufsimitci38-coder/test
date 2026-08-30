const API = '/api/price-tracker';

const el = {
  statusText: document.getElementById('status-text'),
  refreshBtn: document.getElementById('refresh-btn'),
  alertsOnly: document.getElementById('alerts-only'),
  colorSelect: document.getElementById('color-select'),
  setSelect: document.getElementById('set-select'),
  sortSelect: document.getElementById('sort-select'),
  thresholdNote: document.getElementById('threshold-note'),
  container: document.getElementById('cards-container'),
  template: document.getElementById('card-template'),
};

// Best-effort CSS color for each One Piece TCG color name, used for the
// small swatch dot on each card. A dual-color card (e.g. "Blue/Purple")
// gets a two-color gradient split down the middle; anything unrecognized
// falls back to a neutral gray rather than guessing.
const COLOR_SWATCHES = {
  red: '#e0433d',
  green: '#2f9e5c',
  blue: '#2f7de0',
  purple: '#8a4fd1',
  black: '#3a3a3a',
  yellow: '#e0c22f',
};

function swatchCss(colorName) {
  const parts = (colorName || '')
    .split('/')
    .map((p) => COLOR_SWATCHES[p.trim().toLowerCase()])
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return `linear-gradient(90deg, ${parts[0]} 50%, ${parts[1]} 50%)`;
}

function fmtMoney(v) {
  return v == null ? '—' : `$${v.toFixed(2)}`;
}

function fmtPct(v) {
  if (v == null) return 'not enough history yet';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtPctShort(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtDate(v) {
  return v ? new Date(v).toLocaleString() : 'never';
}

function sparklinePoints(history) {
  const prices = history.map((h) => h.marketPrice).filter((p) => p != null);
  if (prices.length < 2) return '';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const stepX = 100 / (prices.length - 1);
  return prices
    .map((p, i) => `${(i * stepX).toFixed(2)},${(30 - ((p - min) / range) * 28 - 1).toFixed(2)}`)
    .join(' ');
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${url} -> HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

async function loadStatus() {
  try {
    const status = await fetchJson(`${API}/status`);
    el.statusText.textContent = `Provider: ${status.provider} · ${status.cardCount} cards tracked · ` +
      `${status.alertCount} alert(s) · last refreshed ${fmtDate(status.lastRefreshAt)}`;
    el.thresholdNote.textContent =
      `Alerting on cards ≥ $${status.thresholds.minPrice} with a ≥ ${status.thresholds.pctChange}% ` +
      `move over the last ${status.thresholds.lookbackDays} days.`;
  } catch (err) {
    console.error('Failed to load status:', err);
    el.statusText.textContent = `Couldn't reach the server (${err.message}). Check server logs.`;
  }
}

function fillSelect(select, options, currentValue) {
  const previous = currentValue ?? select.value;
  // Keep the first option (the "All ..." default) and replace the rest.
  select.length = 1;
  for (const opt of options) {
    const el2 = document.createElement('option');
    el2.value = opt.value;
    el2.textContent = opt.label;
    select.appendChild(el2);
  }
  if ([...select.options].some((o) => o.value === previous)) {
    select.value = previous;
  }
}

async function loadFacets() {
  try {
    const facets = await fetchJson(`${API}/facets`);
    fillSelect(el.colorSelect, facets.colors.map((c) => ({ value: c, label: c })));
    fillSelect(el.setSelect, facets.sets.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` })));
  } catch (err) {
    console.error('Failed to load filter options:', err);
  }
}

async function loadCards() {
  el.container.innerHTML = '<p class="empty-state">Loading cards…</p>';
  const params = new URLSearchParams({
    alertsOnly: el.alertsOnly.checked,
    sort: el.sortSelect.value,
    color: el.colorSelect.value,
    setCode: el.setSelect.value,
  });

  let cards;
  try {
    cards = await fetchJson(`${API}/cards?${params}`);
  } catch (err) {
    console.error('Failed to load cards:', err);
    el.container.innerHTML =
      `<p class="empty-state">Couldn't load cards: ${err.message}<br />Check the server logs, or try "Refresh now".</p>`;
    return;
  }

  if (!cards.length) {
    el.container.innerHTML = '<p class="empty-state">No cards yet. Click "Refresh now" to fetch prices.</p>';
    return;
  }

  el.container.innerHTML = '';
  for (const card of cards) {
    el.container.appendChild(renderCard(card));
  }
}

function renderCard(card) {
  const node = el.template.content.cloneNode(true);
  const root = node.querySelector('.card');
  if (card.alert) root.classList.add('is-alert');

  const img = node.querySelector('.card-img');
  if (card.imageUrl) {
    img.src = card.imageUrl;
    img.alt = card.name;
  } else {
    img.remove();
  }

  node.querySelector('.alert-badge').hidden = !card.alert;
  node.querySelector('.card-name').textContent = card.name;
  node.querySelector('.card-set-text').textContent = `${card.setName}${card.number ? ` · ${card.number}` : ''}`;

  const dot = node.querySelector('.color-dot');
  const swatch = swatchCss(card.color);
  if (swatch) {
    dot.style.background = swatch;
    dot.title = card.color;
    dot.hidden = false;
  }

  node.querySelector('.current-price').textContent = fmtMoney(card.currentPrice);

  const pctEl = node.querySelector('.pct-change');
  pctEl.textContent = fmtPct(card.pctChange);
  pctEl.classList.add(card.pctChange == null ? 'na' : card.direction);

  node.querySelector('.provisional-badge').hidden = card.hasEnoughHistory;

  const dailyEl = node.querySelector('.mini-change.daily');
  dailyEl.textContent = `1d ${fmtPctShort(card.dailyChangePct)}`;
  dailyEl.classList.add(card.dailyChangePct == null ? 'na' : card.dailyDirection);

  const weeklyEl = node.querySelector('.mini-change.weekly');
  weeklyEl.textContent = `7d ${fmtPctShort(card.weeklyChangePct)}`;
  weeklyEl.classList.add(card.weeklyChangePct == null ? 'na' : card.weeklyDirection);

  node.querySelector('.price-past').textContent = card.hasEnoughHistory
    ? `${fmtMoney(card.priceLookbackDaysAgo)} ~30 days ago`
    : `Collecting history — ${card.historyDaysCollected}/${card.historyDaysNeeded} days so far`;

  const link = node.querySelector('.tcg-link');
  link.href = card.url;

  const svg = node.querySelector('.sparkline');
  fetch(`${API}/cards/${card.productId}/history`)
    .then((r) => r.json())
    .then((detail) => {
      const points = sparklinePoints(detail.history || []);
      if (points) {
        svg.innerHTML = `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" />`;
        svg.style.color = card.direction === 'down' ? 'var(--down)' : 'var(--up)';
      }
    })
    .catch(() => {});

  return node;
}

async function refresh() {
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = 'Refreshing…';
  try {
    await fetch(`${API}/refresh`, { method: 'POST' });
    await Promise.all([loadStatus(), loadFacets(), loadCards()]);
  } catch (err) {
    console.error(err);
    alert('Refresh failed. Check the server logs.');
  } finally {
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = 'Refresh now';
  }
}

el.refreshBtn.addEventListener('click', refresh);
el.alertsOnly.addEventListener('change', loadCards);
el.sortSelect.addEventListener('change', loadCards);
el.colorSelect.addEventListener('change', loadCards);
el.setSelect.addEventListener('change', loadCards);

loadStatus();
loadFacets().then(loadCards);
