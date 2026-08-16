# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

The same Icaria vault/keeper system as `Trading-bot` (the PulseChain repo this
was forked from), redeployed for Robinhood Chain - a public, EVM-compatible
Arbitrum Orbit L2 that went live July 1, 2026, trading permissionlessly on
Uniswap v2/v3/v4. ETH is the native gas token; WETH wraps it for pairing.

Users deposit WETH into a per-user vault contract they own. A keeper service
watches prices and new pairs and calls `executeSwap` on their vault. The
platform takes 0.25% per trade plus a gas reimbursement, same as PulseChain.

Two parts so far (site/ not ported yet - see Status):
- `contracts/` - BotVault, VaultFactory, SwapProbe. Identical Solidity to the
  PulseChain repo, unmodified. Chain-specific values are constructor/env
  arguments, never hardcoded in the contracts themselves.
- `keeper/` - Node/TypeScript service. Same codebase as the PulseChain
  keeper, adapted: `wpls`/`WPLS` renamed to `weth`/`WETH` throughout (it now
  holds a real WETH address, not WPLS), default Router/Factory/WETH addresses
  updated to Robinhood Chain's real deployments, gas/probe-size defaults
  rescaled from PLS-magnitude to ETH-magnitude placeholders.

## Status

**Nothing here has been deployed or run yet.** The keeper typechecks and its
existing test suite passes against the renamed code. No contract has been
deployed to Robinhood Chain, no live trade has happened, no gas costs have
been measured. Everything numeric that looks like a real value (gas ceiling,
probe size) is a placeholder pending real observation - see the comments in
`keeper/.env.example` and `keeper/src/config.ts` for exactly which.

## Addresses used here, and how they were obtained

Verify these yourself before trusting them for anything real - this is a
statement of where they came from, not a substitute for checking:

- **WETH** `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` - copied verbatim
  from `docs.robinhood.com/chain/contracts`, screenshot supplied by the user.
- **Uniswap V2 Factory** `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` and
  **Router02** `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` - copied from
  `developers.uniswap.org/docs/protocols/v2/deployments`, screenshot supplied
  by the user. Left in the exact lowercase form given - an earlier attempt to
  manually re-case these into a checksummed format introduced a wrong
  checksum on the Router address, caught only because the test suite tried
  to load it via `ethers.getAddress()` and threw. Do not hand-edit the case
  of an address; if it needs checksumming, run it through code that actually
  computes EIP-55, or leave it lowercase (ethers accepts and correctly
  checksums a fully lowercase address without complaint).
- **USDG** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` - same
  `docs.robinhood.com/chain/contracts` screenshot, used only as a doctor.ts
  sanity-check pair, not load-bearing for trading.
- **Chain ID** 4663 (mainnet) - from web research, not independently
  cross-checked against a second source.
- **RPC URL** - deliberately has no default anywhere in this codebase. No
  public mainnet RPC was verified during setup. Get one from
  `docs.robinhood.com/chain/connecting` before running anything.

## What would help most, in order

1. Deploy `VaultFactory`/`BotVault`/`SwapProbe` to Robinhood Chain mainnet
   (Remix, same flow as the PulseChain deployment) and record the addresses
   here and in `keeper/.env`.
2. Get a real mainnet RPC URL and fill in `keeper/.env` from
   `keeper/.env.example`.
3. Run `npm run doctor` in `keeper/` and fix everything it flags before
   going anywhere near `DRY_RUN=false`.
4. Deposit, withdraw, prove the exit works, exactly like the PulseChain bot's
   own history (see that repo's HANDOFF.md for what that process looked like).
5. Measure real gas costs and correct `MAX_GAS_PRICE_GWEI` and the executor's
   reimbursement assumptions - both are unmeasured placeholders right now.
6. Port `site/` from the PulseChain repo. Its contract addresses/RPC/chain ID
   are already environment-driven (see `site/lib/contracts.js` there), so
   this should mostly be a second deployment with different env vars plus a
   landing page that lets a visitor choose PulseChain or Robinhood Chain
   before connecting a wallet - not a rewrite.

## Invariants that must not break

Same as the PulseChain repo, because the contracts are the same code:

1. `executeSwap` must never gain a path that sends tokens anywhere except the
   vault itself or the treasury (fee and gas only).
2. `withdraw` stays owner-only, no timelock.
3. `revokeExecutor` must work regardless of whether the keeper is running.
4. Trade size caps and cooldowns stay enforced on-chain, not only in the UI.
5. The keeper never holds user funds and never has withdrawal rights.

## The malicious-token problem

The user has personally lost funds on Robinhood Chain to a token that could
not be resold and that redirected purchased balances to another wallet on
transfer. `SwapProbe.sol` (unmodified from the PulseChain repo) exists
specifically to catch this pattern before a real buy: it performs one free
simulated buy-then-sell (`eth_call` with a balance override, no real funds,
no real gas) and compares what should come back against what actually does.
This catches "cannot resell" and "value disappears on transfer" reliably. It
cannot catch a token whose hostile behavior is deliberately deferred past the
simulated block (owner-triggered, N-buyers-triggered, etc.) - screening
narrows the failure rate, it does not eliminate it. Say which claim applies
when discussing this with the user; do not imply guaranteed safety.

## Conventions

- Comments explain *why*, particularly where something non-obvious was
  learned the hard way on the PulseChain bot and applies again here.
- Do not use the em dash character anywhere in code, comments, or docs.
- Verify contract addresses independently (a real block explorer, not just
  this file) rather than trusting any address here.

## Honesty expectations

State plainly what has been run versus what has been reasoned about. "I read
the code and it looks right" and "I ran it, here is the transaction hash" are
very different claims. Say which one applies.
