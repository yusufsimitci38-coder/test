const TABS = {
  price: { tab: document.getElementById('tab-price-tracker'), view: document.getElementById('view-price-tracker') },
  favorites: { tab: document.getElementById('tab-favorites'), view: document.getElementById('view-favorites') },
  event: { tab: document.getElementById('tab-event-tracker'), view: document.getElementById('view-event-tracker') },
};

function activateTab(name) {
  for (const [key, { tab, view }] of Object.entries(TABS)) {
    const isActive = key === name;
    tab.classList.toggle('active', isActive);
    view.hidden = !isActive;
  }
  if (name === 'event' && typeof window.ensureEventsLoaded === 'function') {
    window.ensureEventsLoaded();
  }
  if (name === 'favorites' && typeof window.ensureFavoritesLoaded === 'function') {
    window.ensureFavoritesLoaded();
  }
}

TABS.price.tab.addEventListener('click', () => activateTab('price'));
TABS.favorites.tab.addEventListener('click', () => activateTab('favorites'));
TABS.event.tab.addEventListener('click', () => activateTab('event'));
