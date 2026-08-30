const tabPriceTracker = document.getElementById('tab-price-tracker');
const tabEventTracker = document.getElementById('tab-event-tracker');
const viewPriceTracker = document.getElementById('view-price-tracker');
const viewEventTracker = document.getElementById('view-event-tracker');

function activateTab(name) {
  const isPrice = name === 'price';
  tabPriceTracker.classList.toggle('active', isPrice);
  tabEventTracker.classList.toggle('active', !isPrice);
  viewPriceTracker.hidden = !isPrice;
  viewEventTracker.hidden = isPrice;
  if (!isPrice && typeof window.ensureEventsLoaded === 'function') {
    window.ensureEventsLoaded();
  }
}

tabPriceTracker.addEventListener('click', () => activateTab('price'));
tabEventTracker.addEventListener('click', () => activateTab('event'));
