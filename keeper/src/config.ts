import "dotenv/config";
import { getAddress } from "ethers";

const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const opt = (k: string, d: string): string => process.env[k] || d;
const num = (k: string, d: string): number => Number(opt(k, d));
const bool = (k: string, d: string): boolean => opt(k, d).toLowerCase() === "true";
const addr = (k: string, d?: string): string => {
  const raw = d === undefined ? req(k) : opt(k, d);
  try { return getAddress(raw); } catch { throw new Error(`env ${k} is not an address: ${raw}`); }
};

export const CFG = {
  // No default here on purpose - unlike PulseChain's RPC_URL, there is no
  // verified public mainnet RPC for Robinhood Chain in this codebase yet.
  // Get one from docs.robinhood.com/chain/connecting (Alchemy recommended
  // for anything beyond light testing) and set it explicitly.
  rpcUrl: req("RPC_URL"),
  rpcFallback: opt("RPC_FALLBACK", ""),
  chainId: num("CHAIN_ID", "4663"),

  keeperKey: opt("KEEPER_PRIVATE_KEY", ""),
  treasury: addr("TREASURY", "0x0000000000000000000000000000000000000000"),

  vaultFactory: addr("VAULT_FACTORY", "0x0000000000000000000000000000000000000000"),
  // Uniswap V2 on Robinhood Chain (developers.uniswap.org/docs/protocols/v2/deployments).
  router: addr("ROUTER", "0x89e5db8b5aa49aa85ac63f691524311aeb649eba"),
  factory: addr("FACTORY", "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f"),
  weth: addr("WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),

  // ---- V3 (all optional, no fabricated defaults - unverified until you
  // confirm the real addresses against developers.uniswap.org's Robinhood
  // Chain deployments page and set them explicitly). Leaving FACTORY_V3
  // unset disables V3 scanning/trading entirely; the keeper falls back to
  // V2-only, same as before this existed.
  factoryV3: opt("FACTORY_V3", ""),
  routerV3: opt("ROUTER_V3", ""),       // SwapRouter02
  quoterV3: opt("QUOTER_V3", ""),       // QuoterV2 - see abis.ts's caution
  multiVenueVaultFactory: opt("MULTI_VENUE_VAULT_FACTORY", ""),
  probeAddressV3: opt("PROBE_ADDRESS_V3", ""),
  // Standard Uniswap V3 fee tiers, in bps-of-a-percent (500 = 0.05%). A token
  // can have a pool at more than one of these simultaneously; the keeper
  // checks all configured tiers and uses whichever actually has liquidity.
  v3FeeTiers: opt("V3_FEE_TIERS", "500,3000,10000").split(",").map(Number),
  // V3 has no single "reserves" number the way V2 does, so there's no direct
  // equivalent of a vault's per-vault minLiquidityPls floor yet (that would
  // need a site/schema change - not built). Stopgap: reject if quoting the
  // real trade size prices meaningfully worse than quoting a negligible
  // amount on the same pool - a cheap, self-contained signal that the pool
  // is too thin for this trade, independent of any absolute liquidity figure.
  // Global for now, not per-vault-configurable. Unmeasured placeholder, same
  // caveat as MAX_GAS_PRICE_GWEI - tighten once real V3 launches are observed.
  v3MaxPriceImpactBps: num("V3_MAX_PRICE_IMPACT_BPS", "2000"),

  feeBps: num("FEE_BPS", "25"),

  dryRun: bool("DRY_RUN", "true"),
  // Unmeasured placeholder - Robinhood Chain is a normal Arbitrum L2, nowhere
  // near PulseChain's gas market. Tighten this once real gas prices are observed.
  maxGasPriceGwei: num("MAX_GAS_PRICE_GWEI", "100"),
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", "150"),
  globalKill: bool("GLOBAL_KILL", "false"),

  // ---- Scale ----
  // How many vaults the registry/rules/positions loops check at once. Higher
  // finishes a pass faster with many vaults; too high can overwhelm a free RPC.
  keeperConcurrency: num("KEEPER_CONCURRENCY", "8"),
  // Hard ceiling on real trades per minute, across every vault. A backstop
  // against a malfunction, not a throttle on normal use - see chain.ts.
  maxTradesPerMinute: num("MAX_TRADES_PER_MINUTE", "20"),

  pricePollSec: num("PRICE_POLL_SEC", "60"),
  ruleEvalSec: num("RULE_EVAL_SEC", "60"),
  positionCheckSec: num("POSITION_CHECK_SEC", "20"),
  pairScanSec: num("PAIR_SCAN_SEC", "15"),
  registryRefreshSec: num("REGISTRY_REFRESH_SEC", "300"),

  simAddress: addr("SIM_ADDRESS", "0x1111111111111111111111111111111111111111"),
  simAmountEth: num("SIM_AMOUNT_ETH", "0.02"),
  honeypotMaxLossBps: num("HONEYPOT_MAX_LOSS_BPS", "1200"),

  // Rejects a pair whose TOKEN contract already existed more than this many
  // blocks before the pair was created - catches an old/established token
  // getting a brand-new WETH pairing and having the launch bot mistake that
  // for a fresh launch. Robinhood Chain runs ~0.1s blocks (measured directly
  // against the chain, not assumed - see CLAUDE.md), so 36000 blocks is
  // roughly 1 hour - deploy-then-launch-fast token creators clear this easily;
  // a token that's been sitting around for weeks does not, regardless of
  // which quote asset just got paired with it.
  maxTokenAgeBlocks: num("MAX_TOKEN_AGE_BLOCKS", "36000"),

  dbPath: opt("DB_PATH", "./keeper.db"),
  logLevel: opt("LOG_LEVEL", "info"),
};

/** Addresses that count as "liquidity is gone for good". */
export const BURN_ADDRESSES = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
];

/**
 * Known LP locker contracts on Robinhood Chain. Add as you verify them.
 * hoodexplorer.org turned up as "Robinhood Chain Explorer" in research for
 * this file, but is not independently confirmed as the official one here -
 * verify the current explorer before trusting any address against it.
 */
export const KNOWN_LOCKERS: string[] = [
  // "0x...", // fill in and verify against a real block explorer before trusting
];
