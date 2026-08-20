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
 * owner already holds or deposited themselves - not ones the bot
 * discovered. `id` is stable across edits so a fill can be recorded against
 * this exact order and never repeated, even with several orders on the
 * same token (a buy target and a sell target, or two sell targets at
 * different prices).
 */
export interface LimitOrder {
  id: string;
  enabled: boolean;
  token: string;
  side: "buy" | "sell";
  // ETH per whole token. Buy fires when price <= this; sell fires when
  // price >= this.
  targetPrice: number;
  // side=buy: ETH to spend. side=sell: tokens to sell (ignored if sellAll).
  amount: number;
  sellAll: boolean;
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
 *
 * Detection here is V2-only, on purpose, not an oversight - see
 * keeper/src/discovery.ts's module comment for why.
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
 * Hunter Bot: hunts technical dip-buying setups (RSI oversold, a bullish
 * MACD cross, a Bollinger lower-band touch) across every watched token,
 * trading a dedicated slice of the vault's WETH rather than the whole
 * balance - `allocatedPls` caps how much of the vault this bot can ever have
 * deployed at once (freed back as positions close, not a lifetime spend
 * cap), so a bad run stays contained to the amount the owner chose to risk
 * on it, same spirit as "give it $100 and see what it does."
 *
 * A technical setup is not a safety check. Before anything executes, a
 * candidate still runs the same honeypot/tax/LP-lock/renounce screen every
 * other bot runs, AND a liquidity-coherence check (see indicators.ts's
 * liquidityDropIsSuspicious) that catches the specific trap that motivated
 * this bot: a token whose price cratered because its liquidity was pulled,
 * which looks exactly like an oversold dip to pure price/RSI math. That
 * check is not configurable - it always runs.
 *
 * `requireAiApproval` adds one more layer on top of the mechanical checks:
 * a Claude API call (see ai.ts) that judges the whole picture together
 * before an autoBuy fires. It never substitutes for the mechanical checks
 * above, and with no ANTHROPIC_API_KEY configured it fails safe - no
 * verdict means no auto-buy, never a silent bypass.
 *
 * `maxPerTradePls` is a ceiling, not a fixed size - full authority up to
 * that amount, not "always spend exactly this." When requireAiApproval is
 * on, the AI's own verdict decides how much of the ceiling to actually use
 * (see ai.ts's assess()), spending less when its confidence is lower. With
 * requireAiApproval off there is no sizing judgment to defer to, so the
 * bot simply spends the full ceiling every time.
 *
 * `exitMode` chooses how a position this bot opens gets managed:
 *   - "limited": takeProfitPct/stopLossPct/trailingStopPct/timeExitMin all
 *     apply exactly as configured - the same fixed-target exit every other
 *     bot in this codebase uses.
 *   - "full": the AI periodically re-judges the open position (see ai.ts's
 *     assessExit, hunter.ts's reviewFullModePositions) and decides when to
 *     exit - it can ride a winner past what a fixed take-profit would have
 *     locked in. takeProfitPct/trailingStopPct/timeExitMin are not applied
 *     in this mode; stopLossPct still is, unconditionally, as a floor the
 *     AI's judgment cannot override or remove.
 *
 * Detection here is V2-only, on purpose, not an oversight - same reasoning
 * as DiscoveryConfig above (see keeper/src/discovery.ts's module comment):
 * this keeper's price-history/candle collection only ever samples V2 pair
 * reserves, so every token Hunter Bot evaluates is V2-quoted by
 * construction. The BUY side is still vault-kind aware (see hunter.ts's
 * executeHunterBuy), mirroring the identical "detection is V2-only,
 * execution is venue-aware" tradeoff Discovery Bot already made on this
 * repo, for the identical reason.
 */
export interface HunterConfig {
  enabled: boolean;
  mode: "notify" | "autoBuy";
  allocatedPls: number;   // dedicated bankroll deployed at once. 0 disables.
  maxPerTradePls: number;
  maxPerDay: number;
  exitMode: "limited" | "full";

  // At least one enabled trigger must fire for a candidate to qualify.
  requireRsi: boolean;
  rsiOversold: number;         // RSI(14) at or below this = oversold
  requireMacdCross: boolean;   // a bullish MACD crossover just occurred
  requireBollinger: boolean;
  bollingerPercentBMax: number; // at or below this %B = riding the lower band

  minLiquidityPls: number;

  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  requireOwnerRenounced: boolean;

  requireAiApproval: boolean;
  minAiConfidence: "low" | "medium" | "high";

  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  timeExitMin: number;
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
  hunter: HunterConfig;
  // Never let one token exceed this share of the vault's value. The single most
  // important safety setting: without it a dip-buying rule tips the whole vault
  // into one falling token. 0 disables (not recommended).
  maxHoldingPct: number;
  // "v2": BotVault, only ever trades through the V2 router (executeSwap).
  // "multiVenue": MultiVenueVault, can trade V2 or V3 (executeSwapV2/V3).
  // "multiVenueV4": MultiVenueVaultV4, trades V2, V3, or V4 (adds
  // executeSwapV4) - see contracts/MultiVenueVaultV4.sol. Existing vaults
  // are permanently one kind; a clone can never change which implementation
  // it points at. executor.ts dispatches on this field.
  kind: "v2" | "multiVenue" | "multiVenueV4";
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

const DEFAULT_HUNTER: HunterConfig = {
  enabled: false, mode: "notify", allocatedPls: 0, maxPerTradePls: 0, maxPerDay: 3,
  exitMode: "limited",
  requireRsi: true, rsiOversold: 30, requireMacdCross: true,
  requireBollinger: true, bollingerPercentBMax: 0.15,
  minLiquidityPls: 2_000_000, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
  requireLpLock: true, requireOwnerRenounced: false,
  requireAiApproval: true, minAiConfidence: "medium",
  takeProfitPct: 40, stopLossPct: 25, trailingStopPct: 0, timeExitMin: 0,
};

const cache = new Map<string, VaultRecord>();

interface RawConfig {
  launch?: Partial<LaunchConfig>; rules?: TradingRule[]; snipes?: TargetSnipe[];
  limitOrders?: LimitOrder[]; discovery?: Partial<DiscoveryConfig>; hunter?: Partial<HunterConfig>;
  maxHoldingPct?: number;
}
type LoadedConfig = {
  launch: LaunchConfig; rules: TradingRule[]; snipes: TargetSnipe[];
  limitOrders: LimitOrder[]; discovery: DiscoveryConfig; hunter: HunterConfig; maxHoldingPct: number;
};

const EMPTY: LoadedConfig = {
  launch: { ...DEFAULT_LAUNCH }, rules: [], snipes: [], limitOrders: [],
  discovery: { ...DEFAULT_DISCOVERY }, hunter: { ...DEFAULT_HUNTER }, maxHoldingPct: DEFAULT_MAX_HOLDING_PCT,
};

function shape(raw: RawConfig): LoadedConfig {
  return {
    launch: { ...DEFAULT_LAUNCH, ...(raw.launch ?? {}) },
    rules: (raw.rules ?? []).filter((r) => r.enabled),
    snipes: (raw.snipes ?? []).filter((s) => s.enabled && s.amountPls > 0),
    limitOrders: (raw.limitOrders ?? []).filter((o) => o.enabled && o.id),
    discovery: { ...DEFAULT_DISCOVERY, ...(raw.discovery ?? {}) },
    hunter: { ...DEFAULT_HUNTER, ...(raw.hunter ?? {}) },
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

/** Every vault address a factory has ever created, via its allVaults/vaultCount getters. */
async function vaultsOf(factoryAddress: string): Promise<string[]> {
  const f = new Contract(factoryAddress, VAULT_FACTORY_ABI, provider) as Dyn;
  const count = Number(await f.vaultCount());
  const indices = Array.from({ length: count }, (_, i) => i);
  const addrResults = await mapLimit(indices, CFG.keeperConcurrency, async (i) => {
    try { return await f.allVaults(i) as string; } catch { return null; }
  });
  return addrResults.filter((a): a is string => a !== null);
}

/**
 * Fetches and refreshes every vault's on-chain state and config, from both
 * the V2-only VaultFactory and (if configured) the MultiVenueVaultFactory.
 * Runs a bounded number of vaults concurrently (KEEPER_CONCURRENCY) rather
 * than one at a time, so this pass stays well within its own polling
 * interval as the vault count grows.
 */
export async function refresh(): Promise<VaultRecord[]> {
  const v2Addrs = await vaultsOf(CFG.vaultFactory);
  // Multi-venue support is opt-in - an unset factory address just means
  // "no multi-venue vaults exist yet," not an error. Same for V4.
  const multiVenueAddrs = CFG.multiVenueVaultFactory ? await vaultsOf(CFG.multiVenueVaultFactory) : [];
  const v4Addrs = CFG.multiVenueV4VaultFactory ? await vaultsOf(CFG.multiVenueV4VaultFactory) : [];

  const tagged: { addr: string; kind: "v2" | "multiVenue" | "multiVenueV4" }[] = [
    ...v2Addrs.map((addr) => ({ addr, kind: "v2" as const })),
    ...multiVenueAddrs.map((addr) => ({ addr, kind: "multiVenue" as const })),
    ...v4Addrs.map((addr) => ({ addr, kind: "multiVenueV4" as const })),
  ];

  const recs = await mapLimit(tagged, CFG.keeperConcurrency, async ({ addr, kind }) => {
    const v = new Contract(addr, VAULT_ABI, provider) as Dyn;
    try {
      const [owner, executor, paused] = await Promise.all([v.owner(), v.executor(), v.paused()]);
      const executorOk =
        String(executor).toLowerCase() === (process.env.KEEPER_ADDRESS || "").toLowerCase();
      const { launch, rules, snipes, limitOrders, discovery, hunter, maxHoldingPct } = await loadConfig(addr);
      const rec: VaultRecord = { address: addr, owner, paused, executorOk, launch, rules, snipes, limitOrders, discovery, hunter, maxHoldingPct, kind };
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
