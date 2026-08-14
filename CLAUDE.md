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

Three separate bugs of the same shape have already been found and fixed here:

> **buying works, selling reverts, position is stuck forever**

1. Vault called `swapExactTokensForTokens`, which reverts on fee-on-transfer
   tokens when selling.
2. Minimum-output floor came from `getAmountsOut`, which cannot see transfer
   taxes, so the floor was unreachable.
3. Allowlist checked every path token, so a newly launched token could be
   bought but never sold.

All three were found by re-reading with a specific question in mind. Assume
more exist. The Launch Bot buys tokens that are hostile by assumption, so
anything touching arbitrary ERC20 behaviour deserves suspicion.

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

## Honesty expectations

State plainly what has been run versus what has been reasoned about. "I read
the code and it looks right" and "I ran it, here is the transaction hash" are
very different claims. Say which one applies.
