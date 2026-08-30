const express = require('express');
const priceService = require('./priceService');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json(priceService.getStatus());
});

router.get('/cards', (req, res) => {
  const alertsOnly = req.query.alertsOnly === 'true';
  const sort = req.query.sort || 'pctChange';
  res.json(priceService.getCards({ alertsOnly, sort }));
});

router.get('/cards/:productId/history', (req, res) => {
  const card = priceService.getCardHistory(req.params.productId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  res.json(card);
});

router.post('/refresh', async (req, res) => {
  try {
    const result = await priceService.refreshPrices();
    res.json(result);
  } catch (err) {
    console.error('[price-tracker] refresh failed:', err);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
