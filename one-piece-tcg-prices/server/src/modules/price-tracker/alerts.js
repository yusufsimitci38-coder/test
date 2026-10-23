const config = require('../../config');

function computeChange(currentPrice, pastPrice) {
  if (currentPrice == null || pastPrice == null || pastPrice === 0) {
    return { pctChange: null, direction: 'flat' };
  }
  const pctChange = ((currentPrice - pastPrice) / pastPrice) * 100;
  const direction = pctChange > 0.001 ? 'up' : pctChange < -0.001 ? 'down' : 'flat';
  return { pctChange, direction };
}

// A card alerts when it currently costs at least alertMinPrice AND has moved
// at least alertPctChange percent (either direction) over the lookback window.
function evaluateAlert(currentPrice, pastPrice) {
  const { pctChange, direction } = computeChange(currentPrice, pastPrice);
  const alert =
    currentPrice != null && currentPrice >= config.alertMinPrice && pctChange != null && Math.abs(pctChange) >= config.alertPctChange;
  return { pctChange, alert, direction };
}

module.exports = { evaluateAlert, computeChange };
