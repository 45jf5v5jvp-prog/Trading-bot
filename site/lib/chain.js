/**
 * The single source of chain truth for the whole site. Both dashboards
 * (PulseChain and Robinhood Chain) run this exact same codebase; everything
 * that differs between them lives here as a preset, selected by environment
 * variable at build time. Adding a feature to "both sites" now means adding
 * it once.
 *
 * Selection order:
 *   1. NEXT_PUBLIC_CHAIN=pulsechain|robinhood  (explicit, preferred)
 *   2. NEXT_PUBLIC_CHAIN_ID=4663 implies robinhood (belt-and-suspenders: the
 *      Robinhood deployment already sets this, so it picks the right preset
 *      even before its .env gains NEXT_PUBLIC_CHAIN)
 *   3. pulsechain (the original deployment, which historically ran with no
 *      chain-selection variable at all)
 *
 * Every preset value can still be overridden by the specific NEXT_PUBLIC_*
 * variables that existed before this file did - no deployed .env breaks.
 * NOTE for maintainers: each env var must appear as a literal
 * `process.env.NEXT_PUBLIC_X` expression - Next.js only inlines literals
 * into the client bundle, so dynamic lookups would silently read undefined
 * in the browser.
 *
 * CommonJS on purpose: API routes require() it and client code imports it
 * (default-import interop), same split the rest of lib/ already uses.
 */

const PRESETS = {
  pulsechain: {
    key: "pulsechain",
    chainName: "PulseChain",
    chainId: 369,
    // Public RPC, safe to expose in the browser bundle.
    rpcUrl: "https://rpc.pulsechain.com",
    baseSymbol: "WPLS",
    nativeSymbol: "PLS",
    dexName: "PulseX",
    explorerUrl: "https://scan.pulsechain.com",
    wrapped: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
    router: "0x165C3410fC91EF562C50559f7d2289fEbed552d9",
    // PulseX V2 factory - same address the keeper's own FACTORY default uses
    // (keeper/src/config.ts), reused here rather than re-verified fresh,
    // since it's already the live default this deployment trades through.
    factory: "0x29eA7545DEf87022BAdc76323F373EA1e707C523",
    // v2 factory, deployed 2026-08-20 to replace the original
    // (0xf1971425f3F52f6E6e6058Ba7faB5eF446fc7295), which still defaulted
    // every new vault's executor to a wallet whose key was exposed on
    // 2026-08-14. See DEPLOYED-ADDRESSES.md for the full history.
    vaultFactory: "0x5B5d3B68814857695F3Fedfe0543F03166Bc73e0",
    multiVenueVaultFactory: "",
    multiVenueV4VaultFactory: "",
    // V3/V4 pricing addresses - PulseX has no V3 or V4 deployment, so these
    // stay empty like the keeper's own FACTORY_V3/POOL_MANAGER do. Empty
    // means "don't try this venue," not "broken."
    factoryV3: "",
    quoterV3: "",
    poolManager: "",
    probeAddressV4: "",
    // WPLS balances are in the millions - fractional dust is noise.
    balanceMaxDecimals: 2,
    valueMaxDecimals: 0,
    // PLS-scale liquidity floor (see keeper's screener).
    minLiquidityDefault: 2_000_000,
    walletConnectFallbackUrl: "https://bots.icaria.pro",
  },
  robinhood: {
    key: "robinhood",
    chainName: "Robinhood Chain",
    chainId: 4663,
    // The chain's public RPC - independently verified real (eth_chainId
    // returns 4663) and key-free, so exposing it in the bundle leaks nothing.
    // Deployments can still override with their own endpoint.
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    baseSymbol: "WETH",
    nativeSymbol: "ETH",
    dexName: "Uniswap",
    // Official explorer per Uniswap's own deployment docs for this chain.
    explorerUrl: "https://robinhoodchain.blockscout.com",
    wrapped: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    router: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
    // Unset until independently verified on this chain's explorer - Ask
    // Icaria and Hunter Bot are PulseChain-only for now (see their own
    // module comments), so this deployment simply has no V2 factory wired
    // up rather than trusting a guessed address.
    factory: "",
    vaultFactory: "0xfe0EC05B62fD5EA170Cbb40706CD088DB8E06D54",
    // Read straight off the live droplet's own site/.env.local (2026-08-22),
    // same verification standard as vaultFactory/router/wrapped above.
    multiVenueVaultFactory: "0x7C9bcf8935888839ac3F8BfeFca5dcc37D20CF46",
    multiVenueV4VaultFactory: "0x27804E63872Ba6458777524d3603846Be00D2712",
    // V3/V4 pricing addresses. Same "no fabricated defaults" convention as
    // the keeper's own FACTORY_V3/POOL_MANAGER - unset until the matching
    // NEXT_PUBLIC_* var is set on the deployment, matched to keeper/.env.
    factoryV3: "",
    quoterV3: "",
    poolManager: "",
    probeAddressV4: "",
    // ETH-scale amounts (a trade might be 0.0025) - 2 decimals would round
    // real money down to nothing.
    balanceMaxDecimals: 6,
    valueMaxDecimals: 6,
    minLiquidityDefault: 5,
    walletConnectFallbackUrl: "",
  },
};

function pickPreset() {
  const explicit = process.env.NEXT_PUBLIC_CHAIN;
  if (explicit && PRESETS[explicit]) return PRESETS[explicit];
  if (process.env.NEXT_PUBLIC_CHAIN_ID === "4663") return PRESETS.robinhood;
  return PRESETS.pulsechain;
}

const p = pickPreset();

const CHAIN = {
  key: p.key,
  chainName: p.chainName,
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || p.chainId),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || p.rpcUrl,
  baseSymbol: p.baseSymbol,
  nativeSymbol: p.nativeSymbol,
  dexName: p.dexName,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || p.explorerUrl,
  // Both historical names for the wrapped-native token are honored so
  // neither deployment's existing .env needs editing.
  wrapped: process.env.NEXT_PUBLIC_WETH || process.env.NEXT_PUBLIC_WPLS || p.wrapped,
  router: process.env.NEXT_PUBLIC_ROUTER || p.router,
  factory: process.env.NEXT_PUBLIC_FACTORY_V2 || p.factory,
  vaultFactory: process.env.NEXT_PUBLIC_VAULT_FACTORY || p.vaultFactory,
  multiVenueVaultFactory: process.env.NEXT_PUBLIC_MULTI_VENUE_VAULT_FACTORY || p.multiVenueVaultFactory,
  // V2+V3+V4 capable vaults (MultiVenueVaultV4) - the kind that can trade
  // PONS launches. Blank until deployed; new vaults then come from this
  // factory (see useVault.js's most-capable-factory-first resolution).
  multiVenueV4VaultFactory: process.env.NEXT_PUBLIC_MULTI_VENUE_V4_VAULT_FACTORY || p.multiVenueV4VaultFactory,
  factoryV3: process.env.NEXT_PUBLIC_FACTORY_V3 || p.factoryV3,
  quoterV3: process.env.NEXT_PUBLIC_QUOTER_V3 || p.quoterV3,
  v3FeeTiers: (process.env.NEXT_PUBLIC_V3_FEE_TIERS || "500,3000,10000").split(",").map(Number),
  poolManager: process.env.NEXT_PUBLIC_POOL_MANAGER || p.poolManager,
  probeAddressV4: process.env.NEXT_PUBLIC_PROBE_ADDRESS_V4 || p.probeAddressV4,
  balanceMaxDecimals: p.balanceMaxDecimals,
  valueMaxDecimals: p.valueMaxDecimals,
  minLiquidityDefault: p.minLiquidityDefault,
  walletConnectFallbackUrl: p.walletConnectFallbackUrl,
};

module.exports = { CHAIN, PRESETS };
