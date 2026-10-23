const config = require('../../../config');
const tcgcsvProvider = require('./tcgcsvProvider');
const mockProvider = require('./mockProvider');

const providers = {
  tcgcsv: tcgcsvProvider,
  mock: mockProvider,
};

function getProvider() {
  const provider = providers[config.priceProvider];
  if (!provider) {
    throw new Error(
      `Unknown PRICE_PROVIDER "${config.priceProvider}". Valid options: ${Object.keys(providers).join(', ')}`
    );
  }
  return provider;
}

module.exports = { getProvider };
