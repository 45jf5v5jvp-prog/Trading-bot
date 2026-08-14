# Icaria Bots — Deployed Contract Addresses (PulseChain mainnet)

Deployed via Remix on 2026-08-14. Chain ID 369.

| Contract | Address |
| --- | --- |
| BotVault (implementation, never used directly) | `0x3DE8F062D5f95b24a9d2bC8ed28ACbc488cF5212` |
| VaultFactory | `0xf1971425f3F52f6E6e6058Ba7faB5eF446fc7295` |
| SwapProbe | `0xdE18E7b40e9319432318090b7CfbdAa1e67bA597` |

## VaultFactory constructor arguments used
| arg | value |
| --- | --- |
| `_impl` | `0x3DE8F062D5f95b24a9d2bC8ed28ACbc488cF5212` |
| `_executor` (keeper) | `0x472ABdc5FFA9666C32c592b9B9CBc9D1b36533a7` |
| `_treasury` | `0x22B7faCA9f94ed2645364AbEe11F117B56b6469a` |
| `_router` (PulseX V2) | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` |
| `_baseToken` (WPLS) | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` |
| `_feeBps` | `25` (0.25%, can only be lowered from here, never raised) |

## Next steps
1. Verify all three on https://scan.pulsechain.com.
2. Call `createVault([])` on VaultFactory to create your personal vault, then
   `vaultOf(yourAddress)` to get its address. Record that address below once known.
3. Put `VaultFactory` and `SwapProbe` addresses into `keeper/.env`
   (`VAULT_FACTORY=` and `PROBE_ADDRESS=`).
4. Deposit a tiny amount into your vault and withdraw it back out before trusting
   it with anything more.

## Your vault address
_(fill in after calling `vaultOf`)_
