# Flexible Destination Flight Finder

Enter an origin airport and a date range, get back every reachable destination
sorted by price — for "we don't care where, just find the best deal" family
trip planning. A Vite + React frontend backed by a Netlify Function (so any
real API key stays server-side, never shipped to the browser).

## Data source status (read this first)

The original spec named **Kiwi.com Tequila** as the primary data source and
**Amadeus for Developers Self-Service** (Flight Inspiration Search) as the
backup. As of this build (September 2026), **neither is available to a new
personal-project developer**:

- **Kiwi Tequila** closed public self-service signup on May 30, 2024. It's
  now invite-only B2B partner access.
- **Amadeus Self-Service** — the entire portal was decommissioned on
  July 17, 2026. Only Amadeus Enterprise remains.

So this build ships with a **mock provider** (`netlify/functions/providers/mock.js`)
that generates plausible-looking but entirely synthetic destinations/prices,
deterministic per search (same inputs → same results, like a real cached API
would behave). It exercises the full app end to end — form, request/response
shape, sorting, filtering, booking links — with a clear "demo data" banner in
the UI so it's never mistaken for a real price.

**Recommended real data source once you're ready to wire one up:**
[Travelpayouts / Aviasales Data API](https://www.travelpayouts.com/) — free,
open self-serve signup today, and it has a "cheapest destinations from an
origin" endpoint that matches the "flights to anywhere" shape this app needs.
It also generates Aviasales affiliate booking links, filling the "direct
booking link" requirement. Its prices are cached/aggregated (not a live
per-search shop), so it fits the "best available as of last update" framing
already built into the UI, though it's not literally real-time.

Other viable options if you already have (or can get) access: **Duffel**
(free sandbox, real production access needs approval) or a **Skyscanner /
Kiwi partner application**.

### Wiring up a real provider

The backend is built around a provider interface
(`netlify/functions/providers/index.js`) specifically so this swap doesn't
touch the frontend or the function's request/response contract:

1. Implement `search(params)` in a new file under `providers/` (or fill in
   the `travelpayouts.js` stub — it documents the exact endpoint and mapping
   needed).
2. Set the `FLIGHT_PROVIDER` Netlify env var to that provider's name.
3. Set whatever API key/token env var that provider needs.

No other code changes required.

## Core inputs

- Origin airport (3-letter IATA code), with up to 2 saved favorites
  (`localStorage`, this device only)
- Date range: specific start/end dates, or "anytime in [month]"
- Trip length (min/max days)
- Number of travelers
- Max budget (optional)

## Output

Sortable (price / city / departure date) list of destinations, each showing
city + code, total price and per-person price (when travelers > 1),
outbound/return dates, direct/stop count, a booking link (Google Flights
deep-link today — see below), and a manually-curated "kid-friendly" tag with
a filter toggle (`netlify/functions/providers/kidFriendly.js` — just a hand-
maintained IATA code list, not smart).

**Booking links**: with no real flight-shopping API connected, the booking
link opens a Google Flights search for that route and dates — it shows real,
live prices for you to compare against, honestly labeled as not "the" price
this app quoted. Once a provider like Travelpayouts is wired up, swap this
for its affiliate deep-link (see the stub for where).

## Non-goals (v1, matches spec)

- No background/scheduled price checking or push notifications — search
  only runs when you click "Find destinations"
- No guarantee the shown price matches checkout — the UI says so
- No loyalty miles/points pricing

## Run it locally

This project uses [Netlify CLI](https://docs.netlify.com/cli/get-started/)
so the frontend and the function run together (the function isn't reachable
from plain `vite dev` alone):

```bash
npm install
npm install -g netlify-cli   # if you don't already have it
netlify dev                  # serves the app + function together, usually on :8888
```

Or run the frontend only against the deployed function (edit `vite.config.js`'s
proxy target, or just `npm run dev` and accept that `/api/search` 404s until
you deploy):

```bash
npm run dev       # http://localhost:5173
```

## Build

```bash
npm run build     # outputs to dist/
npm run preview
```

## Deploy to Netlify

This is a **separate site** from the rest of this repo (it's an unrelated
tool living in its own subfolder). When connecting the repo in Netlify, set
the site's **Base directory** to `flight-finder`. Build command and publish
directory are already set in `flight-finder/netlify.toml`.

No env vars are required to run the demo (mock provider is the default). Set
`FLIGHT_PROVIDER` + the relevant API key var once a real provider is wired up.
