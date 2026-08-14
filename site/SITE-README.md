# Icaria site (Phase 4)

A Next.js app: the real dashboard (wallet connect, live contract reads,
deposit/withdraw, trading rule editor) plus the config API your keeper already
knows how to read from (`CONFIG_API` in `keeper/.env`).

## What's real here vs. what's left

**Built and tested (35 automated tests, plus real end-to-end curl tests
against the built app - not just unit tests):**
- Config validation, storage, and ownership-verified writes (`lib/schema.js`,
  `lib/store.js`, `lib/auth.js`, `pages/api/vaults/[address]/config.js`)
- Wallet connect, live vault lookup, live owner/executor/paused/balance reads
  (`lib/useVault.js`)
- Deposit, withdraw, and pause/resume - real transactions from the UI
- A full trading-rule editor: any number of independent rules (add/edit/
  remove), not just one (`components/RulesList.jsx`, `RuleEditor.jsx`)
- Launch bot (new-pair sniper) settings, and the holding-cap safety setting -
  both previously invisible in the UI despite the keeper/API already
  supporting them (`components/LaunchSettings.jsx`)
- Trade history: open positions, closed positions, and recent trades, read
  directly (and strictly read-only) from the keeper's own database
  (`lib/keeperDb.js`, `components/HistoryPanel.jsx`)

**Not built yet** (the rest of the original `web/App.jsx` vision): charts,
CSV export, Telegram alerts, ladder-selling (partial exits at multiple
targets - this one also needs keeper changes, not just UI). The foundation
(real data, real auth, tested patterns) is in place for all of these to be
added the same way the pieces above were.

## Run it locally first

    cd site
    npm install
    cp .env.local.example .env.local
    npm run test      # should show 35 passing
    npm run dev        # http://localhost:3000

Connect MetaMask (on PulseChain) and it should find your real vault.

## Deploying: use the same VPS as the keeper, not Vercel

This app stores config in SQLite, a real file on disk. Vercel's standard
serverless hosting does not guarantee that file persists between requests -
a config save could work once and then quietly disappear. Since you already
have a working PulseChain-connected VPS running the keeper, the simplest
correct move is to run this app there too, the same way:

    # on the server, alongside the keeper
    git clone -b claude/trading-bot-testing-hzo37m https://github.com/45jf5v5jvp-prog/Trading-bot.git icaria-bots
    # (skip this clone if icaria-bots/ is already there from the keeper setup - just cd in and git pull)
    cd icaria-bots/site
    npm install
    cp .env.local.example .env.local
    # edit .env.local if needed - the defaults already match your deployed contracts
    npm run build
    pm2 start npm --name icaria-site -- start -- -p 3000
    pm2 save

Cloning `icaria-bots/` with both `keeper/` and `site/` as siblings (the layout
this repo already uses) means the trade-history feature's default
`KEEPER_DB_PATH` (`../keeper/keeper.db`) just works with no extra
configuration - it reads the keeper's real, live database, strictly
read-only.

Then put a reverse proxy (nginx, or your domain host's settings) in front of
port 3000 so `bots.icaria.pro` reaches it, with HTTPS. That domain/proxy setup
is the one piece that needs a decision from you (which registrar/DNS you're
using) - happy to walk through it once you're ready.

If you'd rather use Vercel later, swap `lib/store.js` for a real hosted
database (Vercel Postgres, Supabase, etc.) first - the API route contract
(`getConfig`/`setConfig`) is a thin two-function interface, so that swap
doesn't touch anything else.

## Connecting the keeper to this, once deployed

In `keeper/.env` on the server, set:

    CONFIG_API=http://localhost:3000

(or the real public URL, if the site ends up on a different host than the
keeper). Restart the keeper (`pm2 restart icaria-keeper`) - `registry.ts`
already prefers `CONFIG_API` over the local `config.json` file whenever it's
set, so no keeper code changes are needed for this switch.
