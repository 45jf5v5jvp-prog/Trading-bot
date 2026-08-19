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
    vaultFactory: "0xf1971425f3F52f6E6e6058Ba7faB5eF446fc7295",
    multiVenueVaultFactory: "",
    multiVenueV4VaultFactory: "",
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
    vaultFactory: "0xfe0EC05B62fD5EA170Cbb40706CD088DB8E06D54",
    multiVenueVaultFactory: "",
    multiVenueV4VaultFactory: "",
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
  vaultFactory: process.env.NEXT_PUBLIC_VAULT_FACTORY || p.vaultFactory,
  multiVenueVaultFactory: process.env.NEXT_PUBLIC_MULTI_VENUE_VAULT_FACTORY || p.multiVenueVaultFactory,
  multiVenueV4VaultFactory: process.env.NEXT_PUBLIC_MULTI_VENUE_V4_VAULT_FACTORY || p.multiVenueV4VaultFactory,
  balanceMaxDecimals: p.balanceMaxDecimals,
  valueMaxDecimals: p.valueMaxDecimals,
  minLiquidityDefault: p.minLiquidityDefault,
  walletConnectFallbackUrl: p.walletConnectFallbackUrl,
};

module.exports = { CHAIN, PRESETS };
