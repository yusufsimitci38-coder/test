const express = require('express');
const priceService = require('./priceService');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json(priceService.getStatus());
});

router.get('/cards', (req, res) => {
  const alertsOnly = req.query.alertsOnly === 'true';
  const sort = req.query.sort || 'pctChange';
  const color = req.query.color || '';
  const setCode = req.query.setCode || '';
  res.json(priceService.getCards({ alertsOnly, sort, color, setCode }));
});

router.get('/facets', (req, res) => {
  res.json(priceService.getFacets());
});

router.get('/cards/:productId/history', (req, res) => {
  const card = priceService.getCardHistory(req.params.productId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  res.json(card);
});

router.get('/debug/sample-product', async (req, res) => {
  try {
    res.json(await priceService.debugSampleProduct());
  } catch (err) {
    console.error('[price-tracker] debug sample failed:', err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/debug/fetch-summary', (req, res) => {
  const summary = priceService.getLastFetchSummary();
  if (!summary) return res.status(404).json({ error: 'No refresh has completed yet - try "Refresh now" first.' });
  res.json(summary);
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
