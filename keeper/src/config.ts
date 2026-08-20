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
  rpcUrl: opt("RPC_URL", "https://rpc.pulsechain.com"),
  rpcFallback: opt("RPC_FALLBACK", ""),
  chainId: num("CHAIN_ID", "369"),

  keeperKey: opt("KEEPER_PRIVATE_KEY", ""),
  treasury: addr("TREASURY", "0x0000000000000000000000000000000000000000"),

  vaultFactory: addr("VAULT_FACTORY", "0x0000000000000000000000000000000000000000"),
  router: addr("ROUTER", "0x165C3410fC91EF562C50559f7d2289fEbed552d9"),
  factory: addr("FACTORY", "0x29eA7545DEf87022BAdc76323F373EA1e707C523"),
  wpls: addr("WPLS", "0xA1077a294dDE1B09bB078844df40758a5D0f9a27"),

  feeBps: num("FEE_BPS", "15"),

  dryRun: bool("DRY_RUN", "true"),
  maxGasPriceGwei: num("MAX_GAS_PRICE_GWEI", "3000000"),
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
  // Not racing a launch - an anomaly worth flagging is, by definition, already
  // a 60-minute-old trend, so this runs on the slower price-poll-ish cadence
  // rather than the launch scanner's fast one.
  discoveryScanSec: num("DISCOVERY_SCAN_SEC", "90"),

  simAddress: addr("SIM_ADDRESS", "0x1111111111111111111111111111111111111111"),
  simAmountPls: num("SIM_AMOUNT_PLS", "100000"),
  honeypotMaxLossBps: num("HONEYPOT_MAX_LOSS_BPS", "1200"),

  dbPath: opt("DB_PATH", "./keeper.db"),
  logLevel: opt("LOG_LEVEL", "info"),
};

/** Addresses that count as "liquidity is gone for good". */
export const BURN_ADDRESSES = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
];

/** Known LP locker contracts on PulseChain. Add as you verify them. */
export const KNOWN_LOCKERS: string[] = [
  // "0x...", // fill in and verify on scan.pulsechain.com before trusting
];
