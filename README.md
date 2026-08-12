# Side Action

A golf betting tracker. Made by Scratch Certified.

A Vite + React single-page app. One phone keeps the card for the whole group; an
in-progress round or trip is saved on that device (via `localStorage`) and survives
closing the browser.

## Run it locally

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # outputs to dist/
npm run preview  # serve the production build locally
```

## Deploy to Vercel

This repo is a stock Vite app, so Vercel detects everything automatically. See the
handoff notes for click-by-click steps. In short: import the GitHub repo at
vercel.com, framework preset **Vite**, build command `npm run build`, output
directory `dist`, deploy.

## Install to the iPhone home screen

Open the live URL in Safari on the phone, tap **Share → Add to Home Screen**. It
opens full screen with no browser chrome (web app manifest + apple-touch-icon +
`apple-mobile-web-app-capable`, theme color `#F1F5EC`).

## Icons

The app icons in `public/` are generated from `scripts/make-icons.mjs`
(`npm run icons`) — a gold golf ball on the app's dark green, no image
dependencies.

## What still needs a real backend

localStorage is per-device, so the multi-phone features are hidden for now:
group codes, followers/viewers, and multiple scorekeepers posting from different
foursomes. Those come back with a shared backend (e.g. Supabase). The scoring
engine functions are untouched and move across unchanged.

## Course lookup

Course data comes from [OpenGolfAPI](https://opengolfapi.org) (free, keyless,
ODbL). If the browser blocks it (CORS), the setup screen falls back to the manual
par / stroke-index / yardage editor, which is always available.
