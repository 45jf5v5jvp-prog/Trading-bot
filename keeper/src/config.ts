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
