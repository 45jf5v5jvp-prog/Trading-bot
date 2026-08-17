# Icaria site (Robinhood Chain)

A Next.js app: the dashboard (wallet connect, live contract reads,
deposit/withdraw, trading rule editor) plus the config API the keeper already
knows how to read from (`CONFIG_API` in `keeper/.env`). This is a fork of the
PulseChain `icaria-bots` site, relabeled and repointed at Robinhood Chain
(chain ID 4663) - same code, different contracts and token (WETH instead of
WPLS).

## Before running this: get a safe RPC URL

`NEXT_PUBLIC_RPC_URL` gets bundled into the browser JS - anyone who loads the
site can read it. Do **not** reuse the keeper's own RPC URL if it has a
private API key in it (e.g. an Alchemy URL) - that would leak the key to
every visitor. Get a second RPC URL for this specifically: either a verified
public Robinhood Chain RPC, or a second provider key restricted by HTTP
referrer to this site's domain. This is the one thing that needs a real
decision before deploying - everything else below just works once it's set.

## Run it locally first

    cd site
    npm install
    cp .env.local.example .env.local
    # fill in NEXT_PUBLIC_RPC_URL - see above
    npm run test
    npm run dev        # http://localhost:3000

Connect a wallet switched to Robinhood Chain (chain ID 4663) and it should
find your real vault (or offer to create one).

## Deploying: same VPS as the keeper, not Vercel

This app stores config in SQLite, a real file on disk. Vercel's standard
serverless hosting does not guarantee that file persists between requests -
a config save could work once and then quietly disappear. Deploy this
alongside the Robinhood keeper on the same server instead:

    # on the server, as a sibling of keeper/ (already cloned there)
    cd ~/robinhood-launch-bot
    git pull
    cd site
    npm install
    cp .env.local.example .env.local
    # edit .env.local - fill in NEXT_PUBLIC_RPC_URL at minimum
    npm run build
    pm2 start npm --name icaria-robinhood-site -- start -- -p 3001
    pm2 save

Port 3001 (not 3000) because the PulseChain site is already running on 3000
on this same server. Keeping `site/` and `keeper/` as siblings under
`robinhood-launch-bot/` means the trade-history feature's default
`KEEPER_DB_PATH` (`../keeper/keeper.db`) just works with no extra
configuration - it reads the keeper's real, live database, strictly
read-only.

Then put a reverse proxy (Caddy, same as the PulseChain site) in front of
port 3001 so it's reachable over HTTPS on its own subdomain or path. That
domain/proxy decision is the one piece that needs you - happy to walk
through it once you're ready.

## Connecting the keeper to this, once deployed

In `keeper/.env` on the server, set:

    CONFIG_API=http://localhost:3001

Restart the keeper (`pm2 restart icaria-robinhood-keeper`) -
`registry.ts` already prefers `CONFIG_API` over the local `config.json`
file whenever it's set, so no keeper code changes are needed for this
switch. Until this is set, the keeper keeps reading `config.json` as it does
now.
