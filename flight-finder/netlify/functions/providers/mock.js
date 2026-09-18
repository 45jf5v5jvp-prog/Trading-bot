/* MOCK PROVIDER — no real flight data.
   Stands in for a real "flights to anywhere" API until one is wired up (see
   README.md for the current state of Kiwi Tequila / Amadeus availability and
   the recommended next candidate, Travelpayouts). It exists so the rest of
   the app — form, request shape, results UI, sorting/filtering — can be
   built and exercised end to end today.

   Every other provider in this directory must export the same shape:
     async function search(params) -> { asOf: isoString, results: Result[] }
   Result: { code, city, country, priceTotal, currency, outboundDate,
             returnDate, stops, bookingUrl, kidFriendly }
   See index.js for how a provider is selected. */
import { AIRPORTS } from './airports.js';
import { isKidFriendly } from './kidFriendly.js';

// Small deterministic PRNG (mulberry32) seeded from the search params, so the
// same search returns the same mock results instead of reshuffling on every
// click — closer to how a real cached/aggregated API would behave.
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function resolveWindow(params) {
  const { dateMode, startDate, endDate, month, tripLengthMin, tripLengthMax } = params;
  const tripLen = Math.max(1, Math.round(((tripLengthMin || 5) + (tripLengthMax || 7)) / 2));
  if (dateMode === 'month' && month) {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const latestStart = Math.max(1, daysInMonth - tripLen);
    return { windowStartDay: 1, windowEndDay: latestStart, year: y, monthIndex: m - 1, tripLen };
  }
  return { startDate: startDate || new Date().toISOString().slice(0, 10), endDate, tripLen };
}

export async function search(params) {
  const { origin, maxBudget, travelers } = params;
  const codes = Object.keys(AIRPORTS).filter((c) => c !== (origin || '').toUpperCase());
  const rand = seededRandom(JSON.stringify(params));
  const win = resolveWindow(params);

  const results = codes.map((code) => {
    const info = AIRPORTS[code];
    // Base price scaled loosely by a rough "distance bucket" so it's not
    // pure noise — international codes trend pricier than domestic ones.
    const intlBump = info.country !== 'US' ? 220 : 0;
    const base = 90 + intlBump + Math.floor(rand() * 380);
    const priceTotal = base * Math.max(1, travelers || 1);

    let outboundDate;
    if (win.year != null) {
      const day = win.windowStartDay + Math.floor(rand() * Math.max(1, win.windowEndDay - win.windowStartDay + 1));
      outboundDate = new Date(Date.UTC(win.year, win.monthIndex, day)).toISOString().slice(0, 10);
    } else {
      const spanDays = win.endDate
        ? Math.max(1, Math.round((new Date(win.endDate) - new Date(win.startDate)) / 86400000))
        : 21;
      const offset = Math.floor(rand() * Math.max(1, spanDays - win.tripLen));
      outboundDate = addDays(win.startDate, offset);
    }
    const returnDate = addDays(outboundDate, win.tripLen);

    return {
      code,
      city: info.city,
      country: info.country,
      priceTotal,
      currency: 'USD',
      outboundDate,
      returnDate,
      stops: rand() < 0.55 ? 0 : 1,
      bookingUrl: googleFlightsUrl(origin, code, outboundDate, returnDate),
      kidFriendly: isKidFriendly(code),
    };
  });

  const filtered = maxBudget ? results.filter((r) => r.priceTotal <= Number(maxBudget)) : results;
  filtered.sort((a, b) => a.priceTotal - b.priceTotal);

  return { asOf: new Date().toISOString(), results: filtered };
}

// Not a "direct booking link" from an airline/OTA API (we have none) — a
// Google Flights search deep-link is the honest stand-in: it opens live,
// real prices for that route/dates, which the mock numbers above are not.
function googleFlightsUrl(origin, dest, outboundDate, returnDate) {
  const q = encodeURIComponent(`Flights from ${origin} to ${dest} on ${outboundDate} through ${returnDate}`);
  return `https://www.google.com/travel/flights?q=${q}`;
}
