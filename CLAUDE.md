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

Six separate bugs of the same shape have already been found and fixed here:

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
5. A different root cause, found while investigating a second live report
   of the same symptom: `positions.ts`'s `openPosition` computed
   `entry_price` with `formatEther`, which always assumes 18 decimals.
   Correct for a typical fresh launch token, wrong for any token that isn't
   (HEX is 8; plenty of tokens use 6 or 9). For those, `entry_price` came
   out wrong by whatever power of ten separates the token's real decimals
   from 18, while `prices.latest()` (used for the current-price side of the
   same comparison) correctly reads each token's real decimals from
   `watched.decimals` - so Hunter's Auto Full AI exit judgment could compare
   two numbers on different scales and believe a position was catastrophically
   down (one live case: the AI's own reasoning said "down 100%... indicating
   either a token meltdown, decimal error in the oracle, or rug pull" - it
   suspected its own bug) when the real close was an ordinary few-percent
   loss. Bounded blast radius: `tokens_held` itself was always stored as the
   raw on-chain amount (decimals-agnostic, never wrong), and both the actual
   stop-loss/take-profit ratio (`checkAndClose`'s `value / spent_pls`, PLS to
   PLS) and the site's own P&L display compare spent/proceeds directly rather
   than through `entry_price` - so this skewed what the AI *believed*, never
   what actually executed or what the dashboard showed. Fixed by looking up
   the token's real decimals from `watched` before computing `entry_price`.
6. A third live report of the same symptom family, this time not about one
   confusing exit but a pattern: Hunter Bot's Auto Full positions kept
   closing at a real loss clustered tightly around 1.3%-1.9%, on plenty of
   different tokens, too consistent to be market noise. Root cause was
   different again: `markToMarket`/`positionsValuePls`/`reviewFullModePositions`
   (already fixed for tax-blindness in bug 4) still quoted a raw AMM price
   with no idea that a REAL close also pays two more charges - the 0.15%
   platform fee and a gas reimbursement (up to 1% of the trade, contract-
   capped) - both taken out of the WPLS proceeds by `BotVault.sol`'s
   `executeSwap` itself, on the way out, not visible to any `getAmountsOut`
   call. So a position the AI believed was roughly flat was already a small
   guaranteed loss the moment it was actually sold - explaining both why the
   loss was consistent (fee+gas are close to a fixed % of a similarly-sized
   trade) and why it happened across unrelated tokens (the blind spot is
   structural, not token-specific). A second, compounding bug sat right next
   to it: `executor.ts` recorded `proceeds_pls` from its own pre-trade quote
   estimate rather than the vault contract's actual `Traded` event, so the
   very P&L numbers being used to sanity-check this were themselves
   overstating what the vault really kept. Fixed by adding `executor.ts`'s
   `netOfExitCosts` (mirrored on the site as `livePrice.js`'s
   `netOfExitCostsPls`) - reads the vault's own `feeBps`/`maxGasFeeBps` and a
   live gas estimate, nets both out the same way the contract will - applied
   everywhere a position's current value gets decided (`markToMarket`,
   `positionsValuePls`, Hunter's AI review, the site's own P&L display), and
   by reading the real on-chain `Traded.amountOut` for `proceeds_pls`/
   `tokensOut` instead of trusting the pre-trade quote. `limits.ts`'s sell-
   side orders are the one deliberate carve-out again, same reason as bug
   4's: its `currentPrice()` quotes a per-unit price before it knows the
   trade size a resting order would actually sell, so there's no total value
   to net real costs out of at that point - would need restructuring
   `fireOrder`'s call order to fix properly, not done yet.

A second, unrelated cause came out of that same conversation, once the owner
pushed back that fee/gas-blindness alone couldn't explain positions closing
within a few minutes of opening (a fee/gas-blind AI should still land near
breakeven either way, not exit almost immediately) - not a quote-blindness
bug at all, a decision-cadence one. `hunter.ts`'s Auto Full re-asks the AI
whether to hold or sell on every hunter tick (as often as every
`HUNTER_SCAN_SEC`, 90s by default) starting the moment a position opens, and
`ai.ts`'s `EXIT_SYSTEM_PROMPT` had no patience guidance at all - "there is
nothing wrong with taking a solid profit rather than holding out for more"
with no anchor for how much time a setup needs to actually develop. A
position could be judged "not worth holding" 90 seconds after being bought,
off almost no real price action. Fixed two ways: `hunter.ts` now has a hard
`MIN_HOLD_MINUTES_BEFORE_AI_REVIEW` (20 minutes) below which the AI isn't
consulted at all - not a suggestion, a mechanical floor, same "hard rule
underneath the AI" pattern `MANDATORY_MIN_STOP_LOSS_PCT` already uses - and
the exit prompt now explicitly tells the model a young position sitting
near entry is normal unresolved noise, not fading, and to weigh
`minutesHeld` before reading meaning into a small move. Refined once more
after owner feedback: the floor shouldn't block taking a genuine fast win
just because the clock hasn't run out, so it only holds back a position
that's flat or marginal this early (`EARLY_REVIEW_MIN_GAIN_PCT`, 5% -
comfortably above the fee/gas floor above and ordinary noise) - a position
already up by a real margin gets evaluated for profit-taking immediately,
no matter how young.

A third finding, this time from the owner noticing Launch Bot's real PLS
spend in the trade history looked nothing like its configured
`perLaunchPls` (150,000) - amounts like 0, 2, 347, and 2,292,913 PLS on
different rows. Launch Bot itself was fine; the trade log was lying.
`positions.ts`'s shared `checkAndClose` hardcoded `bot: "launch"` on every
exit's `fires` row regardless of which bot actually opened the position -
so a Hunter (or Discovery, Rules, Snipe) position closing showed up
mislabeled as a Launch trade. Compounding it, `executor.ts` recorded that
row's `amount` via `formatEther(req.amountIn)` - correct on a buy (input is
always WPLS, 18 decimals) but wrong on a sell, where the input is the
token being sold, whose real decimals vary (HEX is 8, plenty are 6 or 9) -
same `formatEther`-assumes-18 mistake as bug 5, applied to a different
field. Cross-checked against the owner's own earlier "-1.4%/-1.6%/-1.9%"
Hunter closes: the mislabeled rows matched those exact tokens and
timestamps. Fixed by using the position's real `r.bot` instead of a
hardcoded string, and by reading the true input-token decimals (WPLS for
a buy, `watched.decimals` for a sell) instead of assuming 18. Also fixed
the row's `fee` the same way `proceeds_pls` was fixed in bug 6 - reading
the real fee off the trade's own `Traded` event instead of estimating it
from the (now known to be sometimes-wrong-unit) `amountIn` - which matters
beyond display accuracy, since `fires.fee` is exactly what the referral
program sums to calculate a referrer's payout. Already-recorded history
was left untouched; only new trades get the corrected numbers.

All six numbered bugs share the quote-blindness shape; the AI-patience
finding and the mislabeled-trade-history finding are different kinds of
bug from the same run of live conversations, included here because each
was just as real and just as much a live-money (or live-trust) problem.
All were found by re-reading with a specific question in mind (#4, #5, #6,
and the two that followed it were all reported live, from the same owner
watching the same bot - first a position that closed at a real 2% loss
after the bot believed, and told its owner, it was up 40%, then a second
one the owner flagged as "exited early... doesn't make sense" that turned
out to be a completely different bug hiding behind a similar-looking
symptom, then a third time as a *pattern* across many positions rather
than one confusing trade, then a fourth time as numbers in the trade
history that didn't add up at all). Assume more exist. The Launch Bot buys
tokens that are hostile by assumption, so anything touching arbitrary
ERC20 behaviour deserves suspicion.

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
- **Market-wide seeding progress** (how many PulseX pairs have been
  classified, how many tokens actually cleared the liquidity bar and are
  watched/tradeable, whether the scan has caught up to the live pair count):
  `node scripts/seed-progress.js`, same directory/no-key deal as
  vault-count.js above. Reads the keeper's own `keeper.db` plus one live
  `allPairsLength()` call - "done" here means caught up as of right now,
  not a one-time finish line, since PulseX keeps minting new pairs.

## Honesty expectations

State plainly what has been run versus what has been reasoned about. "I read
the code and it looks right" and "I ran it, here is the transaction hash" are
very different claims. Say which one applies.
