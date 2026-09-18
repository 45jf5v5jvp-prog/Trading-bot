/* Flight search relay, running as a Netlify Function so any real API key
 * (once one is wired up — see providers/) stays server-side and never ships
 * to the browser.
 *
 *   POST /.netlify/functions/search
 *   body: { origin, travelers, maxBudget, dateMode, startDate, endDate,
 *           month, tripLengthMin, tripLengthMax }
 *
 * The active data source is swappable via the FLIGHT_PROVIDER env var (see
 * providers/index.js) without touching this handler or the frontend.
 */
import { getProvider } from './providers/index.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: 'ok' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  let params;
  try {
    params = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'invalid JSON body' }) };
  }

  const origin = (params.origin || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'origin must be a 3-letter IATA code' }) };
  }

  try {
    const provider = getProvider();
    const { asOf, results } = await provider.search({ ...params, origin });
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        provider: provider.name,
        asOf,
        results,
        disclaimer:
          provider.name === 'mock'
            ? 'SYNTHETIC DATA — no real flight prices. This deploy has no live flight API connected yet.'
            : 'Best available price as of this search — not guaranteed at checkout.',
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
