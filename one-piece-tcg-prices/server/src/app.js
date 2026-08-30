const path = require('path');
const express = require('express');
const priceTrackerRoutes = require('./modules/price-tracker/routes');

const app = express();

app.use(express.json());

// Each module owns its own namespace under /api/<module>, so future modules
// (e.g. an event tracker) can be mounted the same way without colliding.
app.use('/api/price-tracker', priceTrackerRoutes);

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

module.exports = app;
