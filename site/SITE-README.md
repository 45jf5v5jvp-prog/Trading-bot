# Icaria site

A Next.js app: the real dashboard (wallet connect, live contract reads,
deposit/withdraw, trading rule editor) plus the config API the keeper already
knows how to read from (`CONFIG_API` in `keeper/.env`).

## One codebase, two chains

This exact codebase serves BOTH deployments - the PulseChain dashboard and
the Robinhood Chain dashboard. Every difference between them (chain ID, RPC,
token symbols, DEX name, explorer, contract addresses, display precision,
sensible defaults) is configuration, not code: see `lib/chain.js` for the
presets and `.env.local.example` for how a deployment picks one:

    NEXT_PUBLIC_CHAIN=pulsechain    # or: robinhood

Adding a feature to "both sites" means adding it here once. Do not fork this
directory per chain again - that experiment produced drift bugs (features
existing on one chain and not the other) and was deliberately unwound.

## RPC safety note

`NEXT_PUBLIC_RPC_URL` gets bundled into the browser JS - anyone who loads the
site can read it. Do **not** use an RPC URL with a private API key in it
(e.g. an Alchemy URL) - that would leak the key to every visitor. The presets
default to key-free public RPCs for both chains; only override with something
equally safe to expose, or a provider key restricted by HTTP referrer to this
site's domain.

## What's real here

- Config validation, storage, and ownership-verified writes (`lib/schema.js`,
  `lib/store.js`, `lib/auth.js`, `pages/api/vaults/[address]/config.js`)
- Wallet connect (injected + WalletConnect), silent reconnect on refresh,
  live vault lookup across both factory generations (V2-only and
  multi-venue V2+V3), live owner/executor/paused/balance reads
  (`lib/useVault.js`)
- Deposit, withdraw, pause/resume, emergency per-token withdrawal - real
  transactions from the UI
- A full trading-rule editor: any number of independent rules
  (`components/RulesList.jsx`, `RuleEditor.jsx`)
- Launch bot (new-pair sniper) settings including the LP-lock and
  ownership-renounced screening toggles (`components/LaunchSettings.jsx`)
- Trade history: open positions (with manual close requests), closed
  positions, and recent trades, read directly (and strictly read-only) from
  the keeper's own database (`lib/keeperDb.js`, `components/HistoryPanel.jsx`)

## Run

    npm install
    cp .env.local.example .env.local   # set NEXT_PUBLIC_CHAIN (+ WalletConnect ID)
    npm run build && npm start

Tests: `node --test test/*.test.js`
