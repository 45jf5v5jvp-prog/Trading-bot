import { Contract } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { VAULT_ABI, VAULT_FACTORY_ABI } from "./abis.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";
import { fetchWithTimeout } from "./httpTimeout.js";

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
 * Hunter Bot: hunts real order-flow/liquidity-flow setups across every
 * watched token, trading a dedicated slice of the vault's WPLS rather than
 * the whole balance - `allocatedPls` caps how much of the vault this bot can
 * ever have deployed at once (freed back as positions close, not a lifetime
 * spend cap), so a bad run stays contained to the amount the owner chose to
 * risk on it, same spirit as "give it $100 and see what it does."
 *
 * Used to detect off RSI/MACD/Bollinger, which are all derived from the same
 * price series - "2 of 3 agree" wasn't real diversification, and all three
 * are mean-reversion reads (bet on a bounce) that assume a mature, liquid
 * market this bot doesn't trade in. Replaced with four independent reads:
 * `requireBuyPressure` (real buy/sell trade direction, not price),
 * `requireLiquidityGrowth` (real capital committing, not price),
 * `requireBuyerGrowth` (real new participants, not price), and
 * `requireBreakout` (price confirming strength above its own recent high,
 * not a guessed bottom) - see indicators.ts's orderFlow/liquidityTrend/
 * donchianBreakout and hunter.ts's checkSignals. Every ENABLED one of these
 * must pass - not a vote among them, since unlike RSI/MACD/Bollinger they
 * each measure something genuinely different.
 *
 * None of this is a safety check. Before anything executes, a candidate
 * still runs the same honeypot/tax/LP-lock/renounce screen every other bot
 * runs, AND a liquidity-coherence check (see indicators.ts's
 * liquidityDropIsSuspicious) that catches the specific trap that motivated
 * this bot: a token whose price cratered because its liquidity was pulled,
 * which can look exactly like real momentum to price math alone. That check
 * is not configurable - it always runs.
 *
 * `maxPerTradePls` is a ceiling, not a fixed size - the bot spends up to
 * that amount, not "always spend exactly this."
 *
 * Exits: stopLossPct/timeExitMin apply exactly as configured, same as every
 * other bot. Take-profit and trailing are different here - see
 * `tightTrailPct`/`trailWidenAtPct` below for the tiered trail this bot uses
 * instead of a flat one, meant to capture a quick small win without giving
 * up a bigger move that's still running. There is no AI judgment anywhere
 * in Hunter Bot - buy decisions are purely mechanical (order-flow/liquidity/
 * breakout signals + screen), and so are exits.
 */
export interface HunterConfig {
  enabled: boolean;
  mode: "notify" | "autoBuy";
  allocatedPls: number;   // dedicated bankroll deployed at once. 0 disables.
  // When true, allocatedPls is ignored entirely and the allocation check
  // never blocks a buy - maxPerTradePls (still enforced) is the only real
  // ceiling left. Off by default: an owner has to opt into removing the
  // budget cap, not land on it by accident. Mutually exclusive with
  // allocatedResetDaily below - the site's schema validation rejects both
  // being true at once.
  allocatedUnlimited: boolean;
  // When true, allocatedPls caps how much this vault's Hunter Bot may SPEND
  // on buys in the last 24 hours (see hunter.ts's spentPlsLast24h) instead
  // of how much it may have concurrently DEPLOYED (deployedPls) - an old
  // position sitting open a long time no longer keeps the budget tied up;
  // it just ages out of the 24h window on its own. Off by default: the
  // original concurrent-exposure cap stays the default meaning of
  // allocatedPls unless explicitly opted into this instead.
  allocatedResetDaily: boolean;
  maxPerTradePls: number;
  maxPerDay: number;

  // Every ENABLED one of these four must pass - see hunter.ts's
  // checkSignals. Each reads different on-chain data, not just a different
  // formula over the same price series.
  requireBuyPressure: boolean;
  // Fraction (0-1) of trades in the trailing window that must be buys, not
  // sells - see indicators.ts's orderFlow. 0.6 means 60% of recent trades
  // were buys.
  minBuyPressureRatio: number;

  requireLiquidityGrowth: boolean;
  // % change in liquidity over the trailing window that must be cleared -
  // see indicators.ts's liquidityTrend. 0 means "not shrinking"; a positive
  // number requires real growth, not just flatness.
  minLiquidityGrowthPct: number;

  requireBuyerGrowth: boolean;
  // How many DISTINCT wallets must have bought (not just traded) in the
  // last hour - see hunter.ts's BUYER_WINDOW_MIN and db.ts's tokenTraders'
  // side-filtered count(). Different from minUniqueTraders24h below: that's
  // a 24h liveness floor covering both sides of the trade; this is a
  // recent, buy-only participation signal.
  minNewBuyers: number;

  // Price breaking out to a new local high over its own recent lookback
  // window (a Donchian channel) - see indicators.ts's donchianBreakout. No
  // extra threshold to configure; it's a clean yes/no.
  requireBreakout: boolean;

  minLiquidityPls: number;

  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  requireOwnerRenounced: boolean;

  // Defaults to 0 (disabled) - the tiered trail below does the exit work
  // instead, letting a winner run rather than hard-selling at one fixed
  // number. Set a real value here to override the trail with a hard ceiling.
  takeProfitPct: number;
  // When useAtrStop is on, the position's actual stop distance is computed
  // from the token's own ATR(14) at buy time (ATR as a % of price, times
  // atrStopMultiplier) instead of this flat stopLossPct - a volatile token
  // gets a wider stop, a calm one a tighter one, rather than every token
  // getting the same fixed percentage regardless of how much it normally
  // moves. stopLossPct still applies as-is when useAtrStop is off.
  stopLossPct: number;
  useAtrStop: boolean;
  atrStopMultiplier: number;
  // Wide trail - the distance used once a position's peak gain has passed
  // trailWidenAtPct. See portfolio.ts's sellSignal for the full tiered
  // mechanism: below that threshold, tightTrailPct applies instead (a
  // stalled quick pump locks in most of its gain fast); past it, this wider
  // distance takes over so a real move gets room to keep running toward a
  // bigger exit instead of getting stopped out on every wiggle. 0 disables
  // trailing above the widen threshold - the position just rides on
  // tightTrailPct alone if that's set, or not at all if neither is.
  trailingStopPct: number;
  // Tight trail - the distance used while a position's peak gain is still
  // under trailWidenAtPct. Small on purpose: this is what actually delivers
  // "if it makes a quick 4% and stalls, take it" - a small pullback from an
  // early peak exits close to that peak rather than giving most of it back
  // waiting for a bigger target. 0 disables the tiered trail entirely
  // (falls back to plain trailingStopPct behavior, same as every other bot).
  tightTrailPct: number;
  // Peak-gain % (not current PnL - the highest this position has ever been)
  // at which tightTrailPct hands off to the wider trailingStopPct. See
  // portfolio.ts's sellSignal.
  trailWidenAtPct: number;
  // Force a close after this many minutes regardless of tp/sl/trailing, so a
  // position that never hits either target still gets resolved instead of
  // sitting open indefinitely - this is a day-trading bot, not a buy-and-hold
  // one. 0 disables the time exit entirely.
  timeExitMin: number;

  // Require the recent candle volume to be running meaningfully hotter than
  // the token's own baseline before trusting the order-flow/liquidity/
  // breakout signals above - real activity on a token nobody is actually
  // trading is noise, not signal. See indicators.ts's volumeConfirmation().
  requireVolumeConfirmation: boolean;
  minVolumeRatio: number;

  // How many separate trades (matched Swap events, not their $ size) this
  // token needs in the last 24 hours to even be considered - see hunter.ts's
  // minTrades24h check. A token can show real PLS volume off one big trade
  // while otherwise dead, or modest volume while genuinely trading often;
  // trade count answers "is this actually being traded right now" without
  // needing a per-token dollar guess (HEX/INC's normal daily volume looks
  // nothing like a small cap's). 0 disables the check.
  minTrades24h: number;

  // How many DIFFERENT wallets need to have traded this token in the last
  // 24 hours - see hunter.ts's minUniqueTraders24h check and db.ts's
  // tokenTraders. Answers a question minTrades24h/requireVolumeConfirmation
  // both miss: a token can clear a trade-count or volume-ratio floor on one
  // wallet trading with itself repeatedly (wash trading), which reads
  // exactly like real activity to both of those checks. This can't be
  // faked the same way - distinct real wallets is what real, broad
  // interest actually looks like on-chain. Free to compute (reuses the
  // Swap event's own "to" address, already fetched for volume/trade-count -
  // no extra RPC cost). 0 disables the check.
  minUniqueTraders24h: number;

  // Auto-rebuy: when a Hunter position closes on a profit-taking read (a
  // take-profit or a trailing stop - never a stop-loss or a manual close,
  // see hunter.ts's considerAutoRebuys), place a resting
  // rebuy for the same token some percent below the exit price, so a real
  // pullback gets captured as a better entry instead of just walking away.
  // Lives entirely on the keeper's own side (see db.ts's pendingRebuys) -
  // this one signed toggle authorizes it, not a fresh signature per rebuy.
  autoRebuyOnExit: boolean;
  autoRebuyDipPct: number;
  // Give up waiting after this long so a rebuy that never comes doesn't sit
  // forever - the setup that justified it has gone stale by then anyway.
  autoRebuyExpireHours: number;

  // Caps how many Hunter positions this vault can hold open at once,
  // independent of allocatedPls/maxPerTradePls - someone may have plenty of
  // budget left but still want to limit how many simultaneous bets they're
  // carrying (five focused positions vs. thirty scattered ones). Checked in
  // hunter.ts's executeHunterBuy and checkPendingRebuys. 0 disables it.
  maxOpenPositions: number;
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
  // side=buy only: once the buy fills, the resulting tokens become a real
  // tracked position (see limits.ts's fireOrder) so it gets a P&L, a Close
  // Position button, and - if these are set above 0 - an automatic exit at
  // that gain/loss, the same machinery every other bot's positions already
  // use. 0 means no automatic exit, manual Close Position only.
  takeProfitPct: number;
  stopLossPct: number;
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
  enabled: false, mode: "notify", allocatedPls: 0, allocatedUnlimited: false, allocatedResetDaily: false,
  // Raised from 3 - a bot meant to find several trades a day needs real
  // daily headroom, not a cap that stops it after its first 2-3 buys.
  maxPerTradePls: 0, maxPerDay: 20,
  // 0.6: 60% of recent trades being buys is a real, clear majority without
  // requiring an almost-uncontested tape (which barely trades at all).
  requireBuyPressure: true, minBuyPressureRatio: 0.6,
  // 0: liquidity must not be shrinking over the window - real growth is
  // welcome but not required by default, since plenty of genuine setups
  // hold liquidity flat rather than visibly growing it minute to minute.
  requireLiquidityGrowth: true, minLiquidityGrowthPct: 0,
  // 3: a low bar on purpose, same reasoning as minUniqueTraders24h below -
  // real interest clears this easily, a quiet/wash-traded token usually
  // can't.
  requireBuyerGrowth: true, minNewBuyers: 3,
  requireBreakout: true,
  // Raised from 2,000,000 - the owner's own read that thinner tokens are
  // where the noise lives, and a higher liquidity floor is a direct way to
  // favor tokens with real, harder-to-fake trading activity behind them.
  minLiquidityPls: 5_000_000, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
  requireLpLock: true, requireOwnerRenounced: false,
  // 0: no hard take-profit ceiling - the tiered trail below (tightTrailPct/
  // trailWidenAtPct/trailingStopPct) does the exit work instead, letting a
  // real move run rather than force-selling at one fixed number the moment
  // it's crossed.
  takeProfitPct: 0,
  // Tightened from 25 - a bot meant to cycle through several trades a day
  // needs a real, prompt invalidation, not a stop so wide it barely differs
  // from "never sell."
  stopLossPct: 15, useAtrStop: false, atrStopMultiplier: 3,
  // The tiered trail this bot is built around - see portfolio.ts's
  // sellSignal and registry.ts's own field comments above. Below a 6% peak,
  // a tight 2.5% trail locks in most of a quick pump that stalls early
  // ("if it makes a quick 4%, great, exit it" - the owner's own words);
  // past 6%, the wider 6% trail takes over so a real move gets room to run
  // toward a bigger exit instead of getting stopped out on every wiggle.
  trailingStopPct: 6, tightTrailPct: 2.5, trailWidenAtPct: 6,
  // Shortened from 2880 (48h) - this bot is meant to cycle through several
  // trades a day, not hold for two days waiting on a target. A position
  // that's still flat after 6 hours gets resolved so the capital frees up
  // for the next setup, rather than sitting on one stale bet.
  timeExitMin: 360,
  requireVolumeConfirmation: true, minVolumeRatio: 1.5,
  minTrades24h: 30,
  minUniqueTraders24h: 5,
  autoRebuyOnExit: false, autoRebuyDipPct: 15, autoRebuyExpireHours: 48,
  // Raised from 0 (uncapped) - a real ceiling matching what the owner
  // actually wants to be watching at once, rather than letting exposure
  // grow unbounded as long as the PLS budget allows it.
  maxOpenPositions: 15,
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
      const res = await fetchWithTimeout(`${api}/vaults/${vault}/config`);
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
      const { launch, rules, snipes, limitOrders, discovery, hunter, maxHoldingPct } = await loadConfig(addr);
      const rec: VaultRecord = { address: addr, owner, paused, executorOk, launch, rules, snipes, limitOrders, discovery, hunter, maxHoldingPct };
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
