/* Provider registry. Swap the active data source with the FLIGHT_PROVIDER env
   var — no frontend or function-contract changes needed either way.
     FLIGHT_PROVIDER=mock            (default) synthetic data, see mock.js
     FLIGHT_PROVIDER=travelpayouts   real data, needs TRAVELPAYOUTS_TOKEN — see
                                      travelpayouts.js for setup notes; it is a
                                      stub today (throws) until wired up. */
import * as mock from './mock.js';
import * as travelpayouts from './travelpayouts.js';

const PROVIDERS = { mock, travelpayouts };

export function getProvider() {
  const name = (process.env.FLIGHT_PROVIDER || 'mock').trim().toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown FLIGHT_PROVIDER "${name}". Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  return { name, ...provider };
}
