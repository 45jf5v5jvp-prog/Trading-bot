import { Contract } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { VAULT_ABI, VAULT_FACTORY_ABI } from "./abis.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Bot configuration lives off chain. The vault holds funds and enforces hard
 * limits (max trade size, cooldown, executor identity); the settings a user
 * picks in the app live here. Keep it that way: putting rule parameters on
 * chain means a gas fee every time someone drags a slider.
 */
export interface LaunchConfig {
  enabled: boolean;
  perLaunchPls: number;
  maxPerDay: number;
  takeProfitPct: number;
  stopLossPct: number;       // 0 disables
  trailingStopPct: number;   // 0 disables. Sells when price falls this % off its peak.
  timeExitMin: number;       // 0 disables
  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  maxDeployerPct: number;
  minLiquidityPls: number;
  // Off by default so this never silently changes behavior for an existing
  // saved config - a user has to opt in. See screener.ts's checkOwnerRenounced
  // for why this exists: an unrenounced owner is the most common way a token
  // keeps a backdoor to drain a holder after a normal buy/sell probe already
  // passed.
  requireOwnerRenounced: boolean;
}

/**
 * Discovery Bot: watches every token the scanner has ever seen (not just
 * fresh launches - see prices.ts's ensureWatched, now called unconditionally
 * in launch.ts) for a price move and a liquidity increase happening together
 * over a fixed 60-minute window - liquidity growing alongside the price is
 * the cheap, honest signal that real buying is happening, not a wash-traded
 * pump. This is arithmetic on price history the keeper already collects, not
 * an AI/LLM call - the "narrative" field is a plain-English template built
 * from the same numbers, not a model-generated one. Every candidate still
 * runs the identical honeypot/tax/LP-lock/renounce screen a Launch Bot buy
 * gets before anything executes; "trending" is not "safe." Deployer-share
 * is the one Launch Bot check this omits - there's no deployer address on
 * file for a token discovered this way, only for ones seen at pair-creation.
 */
export interface DiscoveryConfig {
  enabled: boolean;
  mode: "notify" | "autoBuy";
  amountPls: number;
  maxPerDay: number;
  minPriceMovePct: number;
  minLiquidityGrowthPct: number;
  minLiquidityPls: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  timeExitMin: number;
  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  requireOwnerRenounced: boolean;
}

/**
 * A user-chosen contract address to buy the instant it becomes tradeable -
 * for a token spotted before its liquidity goes live (a presale, a
 * Telegram/Twitter tip), rather than one this bot discovered on its own.
 * Deliberately screened far more lightly than a Launch Bot buy: the age,
 * deployer-share, and liquidity-floor checks exist to judge a random
 * anonymous token, and none of that applies when a human already decided
 * to buy this specific address. The one gate that stays mandatory is the
 * honeypot/sellability simulation - see snipe.ts - because "can this be
 * sold at all" protects against a fat-fingered or malicious address
 * regardless of how deliberately it was chosen.
 */
export interface TargetSnipe {
  enabled: boolean;
  token: string;
  amountPls: number;
  tpPct: number;
  slPct: number;
  trailingStopPct: number;
  timeExitMin: number;
}

/**
 * A resting order: buy or sell a specific held/watched token when its price
 * crosses a target, instead of the bot's other trigger shapes (a % move
 * from history, a token going live for the first time). Aimed at tokens the
 * owner already holds or deposited themselves - HEX, INC, PLSX, whatever -
 * not ones the bot discovered. `id` is stable across edits so a fill can be
 * recorded against this exact order and never repeated, even if the vault
 * has several orders on the same token (a buy target and a sell target, or
 * two sell targets at different prices).
 */
export interface LimitOrder {
  id: string;
  enabled: boolean;
  token: string;
  side: "buy" | "sell";
  // PLS per whole token. Buy fires when price <= this; sell fires when
  // price >= this - the standard limit-order sense for each side.
  targetPrice: number;
  // side=buy: PLS to spend. side=sell: tokens to sell (ignored if sellAll).
  amount: number;
  // side=sell only: sell the vault's entire live balance of the token
  // instead of a fixed amount - the common case ("just get me out").
  sellAll: boolean;
}

export interface TradingRule {
  enabled: boolean;
  token: string;
  direction: "drops" | "rises";
  thresholdPct: number;
  lookbackHours: number;
  allocPct: number;
  cooldownHours: number;
  maxFires: number;
  // Sell side. Each buy this rule makes opens (or averages into) a position that
  // carries these exits. 0 or omitted disables that particular exit.
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  timeExitMin?: number;
}

export interface VaultRecord {
  address: string;
  owner: string;
  paused: boolean;
  executorOk: boolean;
  launch: LaunchConfig;
  rules: TradingRule[];
  snipes: TargetSnipe[];
  limitOrders: LimitOrder[];
  discovery: DiscoveryConfig;
  // Never let one token exceed this share of the vault's value. The single most
  // important safety setting: without it a dip-buying rule tips the whole vault
  // into one falling token. 0 disables (not recommended).
  maxHoldingPct: number;
}

/** Default holding cap when a config does not specify one. */
export const DEFAULT_MAX_HOLDING_PCT = 40;

const DEFAULT_LAUNCH: LaunchConfig = {
  enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50, stopLossPct: 35,
  trailingStopPct: 0, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
  requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2_000_000,
  requireOwnerRenounced: false,
};

const DEFAULT_DISCOVERY: DiscoveryConfig = {
  enabled: false, mode: "notify", amountPls: 0, maxPerDay: 4,
  minPriceMovePct: 20, minLiquidityGrowthPct: 15, minLiquidityPls: 2_000_000,
  takeProfitPct: 50, stopLossPct: 35, trailingStopPct: 0, timeExitMin: 60,
  maxBuyTaxBps: 1000, maxSellTaxBps: 1000, requireLpLock: true, requireOwnerRenounced: false,
};

const cache = new Map<string, VaultRecord>();

interface RawConfig {
  launch?: Partial<LaunchConfig>; rules?: TradingRule[]; snipes?: TargetSnipe[];
  limitOrders?: LimitOrder[]; discovery?: Partial<DiscoveryConfig>; maxHoldingPct?: number;
}
type LoadedConfig = {
  launch: LaunchConfig; rules: TradingRule[]; snipes: TargetSnipe[];
  limitOrders: LimitOrder[]; discovery: DiscoveryConfig; maxHoldingPct: number;
};

const EMPTY: LoadedConfig = {
  launch: { ...DEFAULT_LAUNCH }, rules: [], snipes: [], limitOrders: [],
  discovery: { ...DEFAULT_DISCOVERY }, maxHoldingPct: DEFAULT_MAX_HOLDING_PCT,
};

function shape(raw: RawConfig): LoadedConfig {
  return {
    launch: { ...DEFAULT_LAUNCH, ...(raw.launch ?? {}) },
    rules: (raw.rules ?? []).filter((r) => r.enabled),
    snipes: (raw.snipes ?? []).filter((s) => s.enabled && s.amountPls > 0),
    limitOrders: (raw.limitOrders ?? []).filter((o) => o.enabled && o.id),
    discovery: { ...DEFAULT_DISCOVERY, ...(raw.discovery ?? {}) },
    maxHoldingPct: raw.maxHoldingPct ?? DEFAULT_MAX_HOLDING_PCT,
  };
}

/**
 * Where a vault's bot settings come from. Two sources, checked in order:
 *
 *   1. CONFIG_API  - the web backend bots.icaria.pro will serve. Used in
 *      production once it exists.
 *   2. CONFIG_FILE - a local JSON file (default ./config.json). This is how you
 *      run your own bots today, before the web backend is built. Shape:
 *        { "defaults": { launch, rules, maxHoldingPct },
 *          "vaults": { "0xvault": { launch, rules, maxHoldingPct } } }
 *      A vault uses its own entry if present, otherwise "defaults", otherwise
 *      an empty (do-nothing) config.
 *
 * Either way the keeper is agnostic: it only sees the shaped result.
 */
async function loadConfig(vault: string): Promise<LoadedConfig> {
  const api = process.env.CONFIG_API;
  if (api) {
    try {
      const res = await fetch(`${api}/vaults/${vault}/config`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return shape((await res.json()) as RawConfig);
    } catch (e) {
      log("warn", "registry", `Config API failed for ${vault}: ${(e as Error).message}`);
      return EMPTY;
    }
  }

  const file = process.env.CONFIG_FILE || "./config.json";
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      defaults?: RawConfig; vaults?: Record<string, RawConfig>;
    };
    const forVault = parsed.vaults?.[vault.toLowerCase()] ?? parsed.vaults?.[vault];
    const raw = forVault ?? parsed.defaults;
    if (!raw) return EMPTY;
    return shape(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      log("warn", "registry", `Config file ${file} unreadable: ${(e as Error).message}`);
    return EMPTY;
  }
}

/**
 * Fetches and refreshes every vault's on-chain state and config. Runs a bounded
 * number of vaults concurrently (KEEPER_CONCURRENCY) rather than one at a time,
 * so this pass stays well within its own polling interval as the vault count
 * grows - with a handful of vaults a sequential loop is plenty fast, but at
 * dozens or hundreds each waiting on its own RPC round trip in turn adds up.
 */
export async function refresh(): Promise<VaultRecord[]> {
  const f = new Contract(CFG.vaultFactory, VAULT_FACTORY_ABI, provider) as Dyn;
  const count = Number(await f.vaultCount());

  const indices = Array.from({ length: count }, (_, i) => i);
  const addrResults = await mapLimit(indices, CFG.keeperConcurrency, async (i) => {
    try { return await f.allVaults(i) as string; } catch { return null; }
  });
  const addrs = addrResults.filter((a): a is string => a !== null);

  const recs = await mapLimit(addrs, CFG.keeperConcurrency, async (addr) => {
    const v = new Contract(addr, VAULT_ABI, provider) as Dyn;
    try {
      const [owner, executor, paused] = await Promise.all([v.owner(), v.executor(), v.paused()]);
      const executorOk =
        String(executor).toLowerCase() === (process.env.KEEPER_ADDRESS || "").toLowerCase();
      const { launch, rules, snipes, limitOrders, discovery, maxHoldingPct } = await loadConfig(addr);
      const rec: VaultRecord = { address: addr, owner, paused, executorOk, launch, rules, snipes, limitOrders, discovery, maxHoldingPct };
      cache.set(addr.toLowerCase(), rec);
      return rec;
    } catch (e) {
      log("warn", "registry", `Skipping vault ${addr}: ${(e as Error).message}`);
      return null;
    }
  });

  const out = recs.filter((r): r is VaultRecord => r !== null);
  const active = out.filter((v) => v.executorOk && !v.paused);
  log("info", "registry", `${out.length} vaults, ${active.length} active`);
  return out;
}

export const registry = {
  all: (): VaultRecord[] => [...cache.values()],
  active: (): VaultRecord[] => [...cache.values()].filter((v) => v.executorOk && !v.paused),
  get: (a: string): VaultRecord | undefined => cache.get(a.toLowerCase()),
};
