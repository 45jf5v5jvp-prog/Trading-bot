/* STUB — not wired up yet.
   Recommended next real data source (see README.md "Data source status"):
   Travelpayouts / Aviasales Data API. As of this writing it's the one
   flexible-destination-shaped API with open, free self-serve signup (Kiwi
   Tequila and Amadeus Self-Service both closed public registration in 2024
   and 2026 respectively).

   To implement:
     1. Sign up at https://www.travelpayouts.com/, get a token.
     2. Set TRAVELPAYOUTS_TOKEN as a Netlify env var and FLIGHT_PROVIDER=travelpayouts.
     3. Call GET https://api.travelpayouts.com/v2/prices/latest (or
        /v1/prices/cheap for a per-destination cheapest-fare list) with
        origin + currency, using the token in the X-Access-Token header.
     4. Map each destination in the response to the Result shape documented
        in mock.js (code, city, country, priceTotal, currency, outboundDate,
        returnDate, stops, bookingUrl, kidFriendly) — city/country can come
        from the /data/en/locations.json reference dump they publish, or the
        local AIRPORTS table in airports.js as a fallback.
     5. Build bookingUrl from their affiliate deep-link format (needs a
        Travelpayouts marker/affiliate id).
   Prices from this API are cached/aggregated on their side (not a live
   per-search shop), so keep the "best available as of last update" framing
   already in the UI — it fits this provider's freshness model well. */
export async function search() {
  throw new Error(
    'travelpayouts provider is a stub — see the setup steps in providers/travelpayouts.js, ' +
    'or set FLIGHT_PROVIDER=mock (the default) to keep using synthetic data.'
  );
}
