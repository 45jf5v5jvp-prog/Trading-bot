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
4. **Phase 4 (website) - started tonight, real progress, not finished.**
   See `site/SITE-README.md` for the full picture. Summary:
   - A working config API (`GET`/`POST /api/vaults/:address/config`) that the
     keeper already knows how to talk to (`CONFIG_API` env var), backed by
     real validation and real on-chain-ownership-verified writes. 23 automated
     tests, all passing.
   - A real dashboard: wallet connect, live vault lookup and reads (owner,
     executor, paused, WPLS balance - nothing simulated), deposit, withdraw,
     and a trading-rule editor that saves through the API above.
   - Verified end to end with a real running server and curl, not just unit
     tests - confirmed the whole request pipeline works up to the actual
     blockchain call (which this specific sandbox can't reach, same
     restriction as everything else PulseChain-related tonight - a real
     server, like the one running the keeper, has no such restriction).
   - **Not yet done:** deploying this site anywhere reachable, the
     domain/DNS setup for `bots.icaria.pro`, and the rest of the original
     `web/App.jsx` design (multiple bots, charts, launch-bot toggle UI). The
     original simulated `web/App.jsx`/`Landing.jsx` files are still in the
     repo under `web/` for their visual design reference, but the new,
     functional site lives in `site/` and is what should actually get
     deployed and built on going forward.

## The three things that need YOUR input next, not more building

1. **Decide where to deploy `site/`.** Recommendation and reasoning are in
   `site/SITE-README.md` - short version: the same VPS as the keeper, not
   Vercel, because of how the config storage works.
2. **DNS/domain for bots.icaria.pro**, once you're ready to point it at
   wherever the site ends up.
3. **Whether/when to build out the rest of the original UI** (multiple bots,
   charts, etc.) - all buildable the same way, on the same tested foundation.

## Everything is committed and pushed

Branch `claude/trading-bot-testing-hzo37m` on
`github.com/45jf5v5jvp-prog/Trading-bot`. Nothing tonight's work depends on
only existing in this chat session or in the scratchpad - it's all in the
repo.
