# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

Automated trading bots for PulseChain (chain ID 369) trading on PulseX V2.
Users deposit WPLS into a per-user vault contract they own. A keeper service
watches prices and new pairs and calls `executeSwap` on their vault. The
platform takes 0.15% per trade plus a gas reimbursement.

Three parts:
- `contracts/` — BotVault, VaultFactory, SwapProbe. Solidity 0.8.24.
- `keeper/` — Node/TypeScript service. Price collector, rule engine, launch
  watcher, position manager.
- `web/` — React UI. Currently uses simulated data.

## Status

**Nothing here has ever run against PulseChain.** The contracts compile and the
keeper typechecks. That is all that has been verified. Everything else is
untested assumption.

The UI is ahead of the backend. Several features in `web/App.jsx` have no
keeper implementation. See HANDOFF.md section 6.

## The bug pattern to hunt

Four separate bugs of the same shape have already been found and fixed here:

> **buying works, selling reverts, position is stuck forever**

1. Vault called `swapExactTokensForTokens`, which reverts on fee-on-transfer
   tokens when selling.
2. Minimum-output floor came from `getAmountsOut`, which cannot see transfer
   taxes, so the floor was unreachable.
3. Allowlist checked every path token, so a newly launched token could be
   bought but never sold.
4. A variant, found from a live report rather than a code read: `getAmountsOut`
   also can't see transfer taxes when it's used to *value* an open position,
   not just to floor a swap. `positions.ts`'s `markToMarket`/`positionsValuePls`
   and `hunter.ts`'s `reviewFullModePositions` all quoted a raw, untaxed price
   to decide whether take-profit/stop-loss had been hit and what an AI exit
   judgment should believe the position was worth - so a real sell-tax token
   could read as up 40% right up until the actual sale (which does account for
   tax, since it's a real on-chain swap) came back at a real loss. The site's
   own `livePrice.js` had the identical blind spot in the P&L it displays.
   Fixed by discounting each of these by the same `screened.sell_tax_bps` the
   min-output floor (bug 2) already measures - see git history around
   2026-08-22 for the fix. Followed up by auditing every OTHER place a bot
   decides to take profit on its own: every bot that opens a position
   through `positions.ts`'s shared `openPosition`/`checkAndClose` (launch,
   discovery, hunter, snipe, rules, limit-order buy fills) was covered by
   that same fix, since they all exit through the one shared
   `markToMarket`. The one exception was `limits.ts`'s SELL-side limit
   orders, which fire on their own independent `currentPrice()` quote and
   never touch `positions.ts` at all - same untaxed-quote bug, fixed the
   same way, since a resting sell-limit order is itself a manual
   take-profit target. Never trust `getAmountsOut` for anything
   proceeds-shaped without discounting it first.

All four were found by re-reading with a specific question in mind (#4 was
reported live: a Hunter Bot position that closed at a real 2% loss after the
bot believed, and told its owner, it was up 40%). Assume more exist. The
Launch Bot buys tokens that are hostile by assumption, so anything touching
arbitrary ERC20 behaviour deserves suspicion.

## What would help most, in order

1. **Tests against a forked PulseChain.** Foundry or Hardhat. Prioritise:
   buying and selling a fee-on-transfer token, a swap that reverts mid-flow,
   the keeper restarting mid-position, the same rule firing twice in a block.
2. **Deploy to testnet, deposit, then withdraw.** Prove the exit works before
   trusting the entrance. Withdrawal is the escape hatch from every other bug.
3. **Adversarial review of `BotVault.sol`.** Assume the keeper key is
   compromised and try to drain a vault. Reentrancy through a hostile token's
   transfer hook is the top concern.
4. **Measure real gas** on an `executeSwap` and correct `GAS_CALM` in
   `web/App.jsx` and the estimates in `keeper/src/executor.ts`.
5. **Build the missing keeper features** listed in HANDOFF.md section 6. The
   holding cap matters most: without it a dip-buying rule puts the entire vault
   into one falling token.

## Invariants that must not break

1. `executeSwap` must never gain a path that sends tokens anywhere except the
   vault itself or the treasury (fee and gas only).
2. `withdraw` stays owner-only, no timelock.
3. `revokeExecutor` must work regardless of whether the keeper is running.
4. Trade size caps and cooldowns stay enforced on-chain, not only in the UI.
5. The keeper never holds user funds and never has withdrawal rights.

## Conventions

- Comments explain *why*, particularly where something non-obvious was learned
  the hard way. Keep those. They are the record of what already went wrong.
- Do not use the em dash character anywhere in code, comments, or docs.
- Verify contract addresses on https://scan.pulsechain.com rather than trusting
  any address in this repo.

## Useful operator commands

- **How many vaults exist**: `node scripts/vault-count.js` (run from the repo
  root on the droplet, e.g. `~/icaria-bots`). Plain on-chain read of the live
  VaultFactory's `vaultCount()`, no key needed. Whenever asked "how many
  vaults have been made" or similar, give this command rather than a block
  explorer link - it runs from the terminal the user is already in.

## Honesty expectations

State plainly what has been run versus what has been reasoned about. "I read
the code and it looks right" and "I ran it, here is the transaction hash" are
very different claims. Say which one applies.
