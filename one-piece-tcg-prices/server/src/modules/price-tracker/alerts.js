const config = require('../../config');

// A card alerts when it currently costs at least alertMinPrice AND has moved
// at least alertPctChange percent (either direction) over the lookback window.
function evaluateAlert(currentPrice, pastPrice) {
  if (currentPrice == null || pastPrice == null || pastPrice === 0) {
    return { pctChange: null, alert: false, direction: 'flat' };
  }
  const pctChange = ((currentPrice - pastPrice) / pastPrice) * 100;
  const alert = currentPrice >= config.alertMinPrice && Math.abs(pctChange) >= config.alertPctChange;
  const direction = pctChange > 0.001 ? 'up' : pctChange < -0.001 ? 'down' : 'flat';
  return { pctChange, alert, direction };
}

module.exports = { evaluateAlert };
