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
  // PublicNode's free endpoint, not the official rpc.pulsechain.com - the
  // official one has been severely congested (keeper loop passes running
  // minutes over their configured interval, see the 2026-08-23 incident),
  // and PublicNode is separate infrastructure that doesn't share that load.
  rpcUrl: opt("RPC_URL", "https://pulsechain-rpc.publicnode.com"),
  // Used only for prices.ts's chain-wide Swap log scan (see chain.ts's
  // logsProvider) - PublicNode rejects that one broad, address-less
  // eth_getLogs call, so it needs an endpoint confirmed not to restrict it.
  // Defaults to the official node specifically because that's the one
  // that's actually been confirmed to handle it.
  rpcFallback: opt("RPC_FALLBACK", "https://rpc.pulsechain.com"),
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
  // How many outbound dollars of liquidity a token needs before market-wide
  // seeding will even add it to `watched` at all - see marketSeed.ts. A
  // dollar figure, not a raw PLS one, since PLS's own price swings enough
  // that a fixed PLS floor would silently tighten or loosen over time.
  minSeedLiquidityUsd: num("MIN_SEED_LIQUIDITY_USD", "5000"),
  // How often the full PulseX pair list gets re-walked for tokens that
  // crossed the liquidity floor since the last pass (a brand-new pair is
  // still caught immediately by launch.ts - this is for pre-existing tokens
  // whose liquidity grows into range later). Pair-list size makes a full
  // pass expensive, so it runs far less often than everything else.
  marketSeedRefreshHours: num("MARKET_SEED_REFRESH_HOURS", "6"),
  // Candle/indicator math is heavier per token than discovery's checks, and
  // a passing candidate may trigger a paid AI call, so this cadence doubles
  // as a cost throttle, not just a "how fresh" choice - lower it further
  // than this only with that tradeoff in mind (was 300s; 90s roughly
  // triples worst-case detection latency without multiplying AI spend as
  // much as going lower would).
  hunterScanSec: num("HUNTER_SCAN_SEC", "90"),

  simAddress: addr("SIM_ADDRESS", "0x1111111111111111111111111111111111111111"),
  simAmountPls: num("SIM_AMOUNT_PLS", "100000"),
  honeypotMaxLossBps: num("HONEYPOT_MAX_LOSS_BPS", "1200"),

  // Empty by default, same "unset means off, not a fake default" rule as
  // PROBE_ADDRESS. Hunter Bot's AI gate and Ask Icaria both no-op with a
  // clear log line rather than guess when this is missing.
  anthropicApiKey: opt("ANTHROPIC_API_KEY", ""),
  anthropicModel: opt("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),

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
