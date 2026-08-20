# Icaria Bots — Deployed Contract Addresses (PulseChain mainnet)

Chain ID 369. **Use the v2 addresses below for anything new.** The v1 section
further down is kept as history, not as something to deploy against.

## Current (v2) — deployed via Remix on 2026-08-20

Replaces v1 for two reasons found in review: v1's VaultFactory defaulted
every new vault's executor to a wallet whose key was exposed in a chat
conversation on 2026-08-14, and `BotVault.sol` picked up a `maxTradeSize` fix
(the owner's per-trade cap is now enforced in WPLS terms on both buy and
sell, not raw token units - see `contracts/BotVault.sol` commit `869ecc1`).

| Contract | Address |
| --- | --- |
| BotVault (implementation, never used directly) | `0x586dcE2185dba2CBA61a804c6c116F366D7f6554` |
| VaultFactory | `0x5B5d3B68814857695F3Fedfe0543F03166Bc73e0` |
| SwapProbe | *(unchanged from v1 - `0xdE18E7b40e9319432318090b7CfbdAa1e67bA597`, not affected by the BotVault fix)* |

### VaultFactory constructor arguments used
| arg | value |
| --- | --- |
| `_impl` | `0x586dcE2185dba2CBA61a804c6c116F366D7f6554` |
| `_executor` | `0xA5519278B6be31545b0318B88e476Bdf13A1567e` (the current, non-compromised keeper wallet - correct by default now, no `setExecutor` workaround needed for new vaults) |
| `_treasury` | `0x22B7faCA9f94ed2645364AbEe11F117B56b6469a` |
| `_router` (PulseX V2) | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` |
| `_baseToken` (WPLS) | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` |
| `_feeBps` | `25` (0.25%, can only be lowered from here, never raised) |

**Verified working, not just deployed:** Remix's environment badge read
"PulseChain" for both contracts (the account balance showed PLS, matching the
working v1 deployment's account), and calling the new VaultFactory directly
in Remix confirmed `vaultCount()` returns `0` and `executor()` reads back
`0xA5519278B6be31545b0318B88e476Bdf13A1567e` exactly. That's on-chain
confirmation, not just a reported address. Still not yet checked against
scan.pulsechain.com's own contract page (bytecode/verification) - worth doing
before depositing anything beyond the standard tiny test amount.

**A first attempt at this redeploy landed on the wrong chain entirely** -
`0x6bAd39Da9B4741bB34cd8474402AdD402665e110` (BotVault) and
`0xf86d01b997CAFE018b72Ff0b7602240a099c1E11` (VaultFactory) were deployed
while Remix's injected provider was pointed at Robinhood Chain, not
PulseChain (MetaMask had been left switched from earlier, unrelated work).
Those two addresses have no PulseChain contract behind them - pointing
`keeper/.env` at the VaultFactory one briefly crash-looped the keeper
(`vaultCount()` returning undecodable empty data) until it was reverted back
to v1 and the redeploy was redone on the correct network. Recorded here only
so nobody mistakes those two addresses for real PulseChain contracts later.

### Droplet status: live on v2 (confirmed 2026-08-20T23:06 UTC)
`keeper/.env` on the production droplet now has
`VAULT_FACTORY=0x5B5d3B68814857695F3Fedfe0543F03166Bc73e0`, and `icaria-keeper`
(pm2) restarted clean onto it - `[chain] Connected to PulseChain, router and
factory`, then `[registry] 0 vaults, 0 active` (0 is correct: nothing has been
created against this factory yet), `[main] All loops running`, no errors.
(Earlier confusion during this rollout: a `pm2 env <id>` check doesn't show
`dotenv`-loaded variables, only what pm2 itself injects at process launch -
it's the wrong tool for checking this. Reading `keeper/.env` directly with
`grep`/`cat` is the reliable way to confirm what's actually configured.)

### Remaining next steps
1. Verify both v2 contracts on https://scan.pulsechain.com (contract page,
   bytecode) as a second confirmation beyond the Remix checks above.
2. Call `createVault([])` on the new VaultFactory from your real long-term
   wallet, then `vaultOf(yourAddress)` to get its address. Confirm its
   `executor()` is already correct - no manual `setExecutor` call needed.
3. Deposit a tiny amount into that vault and withdraw it back out before
   trusting it with anything more (HANDOFF.md section 8).
4. Once confirmed working, treat the v1 VaultFactory below as retired -
   don't create new vaults against it.

---

## v1 — superseded, kept as history (deployed 2026-08-14)

Do not deploy new vaults against this VaultFactory - it defaults every new
vault's executor to a compromised wallet (see below). Existing vaults created
against it before the compromise was found should have `setExecutor` called
if they haven't already.

| Contract | Address |
| --- | --- |
| BotVault (implementation, never used directly) | `0x3DE8F062D5f95b24a9d2bC8ed28ACbc488cF5212` |
| VaultFactory | `0xf1971425f3F52f6E6e6058Ba7faB5eF446fc7295` |
| SwapProbe | `0xdE18E7b40e9319432318090b7CfbdAa1e67bA597` |

### VaultFactory constructor arguments used
| arg | value |
| --- | --- |
| `_impl` | `0x3DE8F062D5f95b24a9d2bC8ed28ACbc488cF5212` |
| `_executor` (keeper, as deployed) | `0x472ABdc5FFA9666C32c592b9B9CBc9D1b36533a7` — **compromised 2026-08-14, do not use.** |
| `_treasury` | `0x22B7faCA9f94ed2645364AbEe11F117B56b6469a` |
| `_router` (PulseX V2) | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` |
| `_baseToken` (WPLS) | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` |
| `_feeBps` | `25` (0.25%, can only be lowered from here, never raised) |

The original keeper wallet (`0x472ABdc5FFA9666C32c592b9B9CBc9D1b36533a7`, baked
into this VaultFactory's constructor) had its private key exposed in a chat
conversation on 2026-08-14 and must never be used again. The test vault below
has had `setExecutor` called to point to the current wallet instead, verified
on-chain. Any vault created via this factory before that fix defaults to the
compromised address as its executor.

### Test vault (owned by Account 16, 0x366...28dd1 — used to prove deposit/withdraw)
`0x523A8848E9a1D7F2E083625d1004f76e607BFCd7`

Note: vault ownership is permanent and tied to whichever wallet called
`createVault`. This vault belongs to Account 16 forever.

## Keeper wallet — CURRENT (use this one)
`0xA5519278B6be31545b0318B88e476Bdf13A1567e`
