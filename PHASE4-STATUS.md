# Phase 4 status — as of 2026-08-14, overnight session

Written for whoever reads this next (you, in the morning, or a developer).
Honest state: what's real and tested vs. what's still ahead.

## What changed tonight, in order

1. **Phase 1 (deploy) - done and proven.** Contracts live on PulseChain
   mainnet, vault created, a full deposit-then-withdraw round trip verified
   on chain. Addresses in `DEPLOYED-ADDRESSES.md`.
2. **Phase 3 (keeper server) - done and running.** The keeper is live on a
   DigitalOcean droplet under pm2, connected to PulseChain, `npm run doctor`
   passes every check, and it's currently running in `DRY_RUN=true` with no
   trading rules configured yet (safe, does nothing but watch).
3. **Keeper wallet rotated.** The original keeper private key was exposed in
   this chat session and retired. The current keeper wallet is
   `0xA5519278B6be31545b0318B88e476Bdf13A1567e`. The one existing vault has
   had `setExecutor` called to this address, verified three independent ways
   (Remix read-back, the doctor script, and the live keeper's own startup log
   all agree). **Any new vault created via the existing VaultFactory will
   default to the OLD address as its executor** - call `setExecutor` on it
   immediately after creation, every time, until a fresh factory is deployed
   with the correct default.
4. **Phase 4 (website) - real, tested progress, not finished.**
   See `site/SITE-README.md` for the full picture. Summary:
   - A working config API (`GET`/`POST /api/vaults/:address/config`) that the
     keeper already knows how to talk to (`CONFIG_API` env var), backed by
     real validation and real on-chain-ownership-verified writes.
   - A real dashboard: wallet connect, live vault lookup and reads (owner,
     executor, paused, WPLS balance - nothing simulated), deposit, withdraw,
     pause/resume, and an editor for any number of independent trading rules
     plus the launch bot and holding-cap settings (previously invisible in
     the UI even though the keeper/API already supported them).
   - Real trade history in the dashboard: open positions, closed positions,
     and recent trades, read directly (strictly read-only) from the keeper's
     own database - answers "is my bot doing anything?" without SSH access.
   - **35 automated tests, all passing**, plus real end-to-end curl tests
     against the actual built-and-running app (not just unit tests) for
     both the config and history endpoints.
   - **Not yet done:** deploying this site anywhere reachable, the
     domain/DNS setup for `bots.icaria.pro`, and a few pieces of the
     original `web/App.jsx` vision - charts, CSV export, Telegram alerts,
     and ladder-selling (which also needs keeper-side changes, not just
     UI). The original simulated `web/App.jsx`/`Landing.jsx` files are
     still in the repo under `web/` for visual design reference, but the
     new, functional site lives in `site/` and is what should actually get
     deployed and built on going forward.

## The two things that need YOUR input next, not more building

1. **Decide where to deploy `site/`.** Recommendation and reasoning are in
   `site/SITE-README.md` - short version: the same VPS as the keeper, not
   Vercel, because of how the config storage works. Deploying `site/`
   alongside `keeper/` (as this repo's layout already has them) also makes
   the trade-history feature work with zero extra config, since it reads
   the keeper's database by relative path by default.
2. **DNS/domain for bots.icaria.pro**, once you're ready to point it at
   wherever the site ends up.

## Everything is committed and pushed

Branch `claude/trading-bot-testing-hzo37m` on
`github.com/45jf5v5jvp-prog/Trading-bot`. Nothing tonight's work depends on
only existing in this chat session or in the scratchpad - it's all in the
repo.
