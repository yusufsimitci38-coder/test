const express = require('express');
const eventService = require('./eventService');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json(eventService.getStatus());
});

router.get('/events', (req, res) => {
  res.json(eventService.getEvents(req.query.month || ''));
});

router.get('/registration-windows', (req, res) => {
  res.json(eventService.getRegistrationWindows());
});

router.get('/debug/sample', async (req, res) => {
  try {
    res.json(await eventService.debugSample());
  } catch (err) {
    console.error('[event-tracker] debug sample failed:', err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/debug/bandai-raw', async (req, res) => {
  try {
    res.json(await eventService.debugBandaiRaw());
  } catch (err) {
    console.error('[event-tracker] debug bandai-raw failed:', err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/debug/topdeck-sample', async (req, res) => {
  try {
    res.json(await eventService.debugTopdeckRaw());
  } catch (err) {
    console.error('[event-tracker] debug topdeck-sample failed:', err);
    res.status(502).json({ error: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const result = await eventService.refreshEvents();
    res.json(result);
  } catch (err) {
    console.error('[event-tracker] refresh failed:', err);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
