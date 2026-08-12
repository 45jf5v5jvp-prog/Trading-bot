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

## Shared leaderboard (Supabase)

The app runs **solo** out of the box — one phone keeps the card, everything saved
on that device. Fill in a Supabase URL + anon key to turn on the **shared
leaderboard**: one person keeps the card and everyone else joins with a 6-character
code to follow the money on their own phone (and optionally keep score for their
own foursome).

Turn it on:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the project, open **SQL Editor** and run:

   ```sql
   create table if not exists kv (
     key text primary key,
     value text,
     updated_at timestamptz default now()
   );
   alter table kv enable row level security;
   create policy "read"   on kv for select using (true);
   create policy "insert" on kv for insert with check (true);
   create policy "update" on kv for update using (true) with check (true);
   create policy "delete" on kv for delete using (true);
   ```

3. In **Project Settings → API**, copy the **Project URL** and the **anon public**
   key.
4. Paste them into the `window.SIDE_ACTION_CONFIG` block near the top of
   `index.html` (or `sideaction.html` — it's plain text you can edit by hand, no
   rebuild needed):

   ```html
   <script>
     window.SIDE_ACTION_CONFIG = {
       SUPABASE_URL: "https://YOURPROJECT.supabase.co",
       SUPABASE_ANON_KEY: "eyJ...your anon key..."
     };
   </script>
   ```

Reload and the "Join with a code" option appears. Leave the values blank and the
app stays solo.

**Note on the security model:** the anon key is public by design (it ships in the
browser), and these policies let anyone with the key read/write the shared table.
A group code is a door key, not a password — fine for a friendly leaderboard, not
for anything sensitive. Tighten the policies later if you want.

The scoring engine functions are untouched and identical to the original.

## Course lookup

Course data comes from [OpenGolfAPI](https://opengolfapi.org) (free, keyless,
ODbL). If the browser blocks it (CORS), the setup screen falls back to the manual
par / stroke-index / yardage editor, which is always available.
