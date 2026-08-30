const API = '/api/price-tracker';

const el = {
  statusText: document.getElementById('status-text'),
  refreshBtn: document.getElementById('refresh-btn'),
  alertsOnly: document.getElementById('alerts-only'),
  sortSelect: document.getElementById('sort-select'),
  thresholdNote: document.getElementById('threshold-note'),
  container: document.getElementById('cards-container'),
  template: document.getElementById('card-template'),
};

function fmtMoney(v) {
  return v == null ? '—' : `$${v.toFixed(2)}`;
}

function fmtPct(v) {
  if (v == null) return 'not enough history yet';
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

async function loadStatus() {
  const status = await fetch(`${API}/status`).then((r) => r.json());
  el.statusText.textContent = `Provider: ${status.provider} · ${status.cardCount} cards tracked · ` +
    `${status.alertCount} alert(s) · last refreshed ${fmtDate(status.lastRefreshAt)}`;
  el.thresholdNote.textContent =
    `Alerting on cards ≥ $${status.thresholds.minPrice} with a ≥ ${status.thresholds.pctChange}% ` +
    `move over the last ${status.thresholds.lookbackDays} days.`;
}

async function loadCards() {
  el.container.innerHTML = '<p class="empty-state">Loading cards…</p>';
  const params = new URLSearchParams({
    alertsOnly: el.alertsOnly.checked,
    sort: el.sortSelect.value,
  });
  const cards = await fetch(`${API}/cards?${params}`).then((r) => r.json());

  if (!cards.length) {
    el.container.innerHTML = '<p class="empty-state">No cards match the current filter.</p>';
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
  node.querySelector('.card-set').textContent = `${card.setName}${card.number ? ` · ${card.number}` : ''}`;
  node.querySelector('.current-price').textContent = fmtMoney(card.currentPrice);

  const pctEl = node.querySelector('.pct-change');
  pctEl.textContent = fmtPct(card.pctChange);
  pctEl.classList.add(card.pctChange == null ? 'na' : card.direction);

  node.querySelector('.price-past').textContent = card.hasEnoughHistory
    ? `${fmtMoney(card.priceLookbackDaysAgo)} ~30 days ago`
    : 'Collecting history — check back in a few weeks';

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
    await Promise.all([loadStatus(), loadCards()]);
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

loadStatus();
loadCards();
