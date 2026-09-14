const path = require('path');
const express = require('express');
const priceTrackerRoutes = require('./modules/price-tracker/routes');
const eventTrackerRoutes = require('./modules/event-tracker/routes');

const app = express();

app.use(express.json());

// Each module owns its own namespace under /api/<module>, mounted the same
// way so more modules can be added without colliding.
app.use('/api/price-tracker', priceTrackerRoutes);
app.use('/api/event-tracker', eventTrackerRoutes);

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

module.exports = app;
