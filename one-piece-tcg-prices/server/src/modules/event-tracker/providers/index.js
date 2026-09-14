const config = require('../../../config');
const limitlessProvider = require('./limitlessProvider');
const mockProvider = require('./mockProvider');

const providers = {
  limitless: limitlessProvider,
  mock: mockProvider,
};

function getProvider() {
  const provider = providers[config.eventProvider];
  if (!provider) {
    throw new Error(
      `Unknown EVENT_PROVIDER "${config.eventProvider}". Valid options: ${Object.keys(providers).join(', ')}`
    );
  }
  return provider;
}

module.exports = { getProvider };
