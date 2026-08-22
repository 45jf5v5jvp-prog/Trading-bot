import { parseEther, Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type VaultRecord, type HunterConfig } from "./registry.js";
import { watched, opportunities, discoveryActions, aiExitRequests, hunterLessons, pendingRebuys, prices, db } from "./db.js";
import { screenOpportunity, fetchBuyRequests, type DiscoveryScreen } from "./discovery.js";
import { candlesForToken } from "./candles.js";
import { snapshot, liquidityDropIsSuspicious } from "./indicators.js";
import { assess, assessExit, reflectOnLoss, reflectOnMiss, type TokenProfile, type AiVerdict, type OpenPositionContext } from "./ai.js";
import { executeSwap, netOfExitCosts } from "./executor.js";
import { openPosition, positionsValuePls } from "./positions.js";
import { exceedsHoldingCap } from "./portfolio.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Hunter Bot: hunts technical dip-buying setups (RSI oversold, a bullish
 * MACD cross, a Bollinger lower-band touch) across every watched token,
 * trading a dedicated slice of the vault the owner chose to risk on it -
 * see registry.ts's HunterConfig for the full reasoning.
 *
 * Shares its findings feed with discovery.ts (the `opportunities` table,
 * tagged source='hunter') so the site's Opportunities panel and manual
 * "Buy Now" flow work identically for both bots without duplicating that
 * plumbing - see discovery.ts's screenOpportunity/fetchBuyRequests, both
 * exported for exactly this reuse.
 */

const CANDLE_MINUTES = 15;
const LOOKBACK_HOURS = 48;
// Longer than discovery's dedup window - an RSI/Bollinger setup that's still
// oversold four hours later is the same setup continuing, not a new one.
const DEDUP_HOURS = 4;
// Roughly the slow MACD(26) + signal(9) warm-up - fewer candles than this
// and macd()/bollinger() come back null anyway, so there's nothing to check.
const MIN_CANDLES = 36;
// Auto Full's floor when stopLossPct was left at 0 - the AI's exit judgment
// is never the ONLY thing standing between an open position and a total
// loss, no matter what the owner set.
const MANDATORY_MIN_STOP_LOSS_PCT = 50;
// Bounds on an ATR-derived stop distance, regardless of atrStopMultiplier -
// a stop tighter than this on a low-cap PulseX token is almost certainly
// noise-triggered, not a real invalidation of the setup; a stop looser than
// this is not meaningfully a stop at all. Applied before the Auto Full
// mandatory floor, which can still raise it further.
const ATR_STOP_MIN_PCT = 5;
const ATR_STOP_MAX_PCT = 80;
// Auto Full re-asks the AI whether to hold or sell on every hunter tick -
// as often as every HUNTER_SCAN_SEC (90s by default) - starting the moment
// a position opens. With nothing gating that, a position could be judged
// "not worth holding" a minute and a half after being bought, off almost no
// real price action - not a genuine read of the setup, just noise. This is
// a floor under the AI, not a substitute for one: the mandatory stop-loss
// below still protects the downside for the duration, same as always.
const MIN_HOLD_MINUTES_BEFORE_AI_REVIEW = 20;
// The one exception to that floor: a position already up by a real margin
// this early is a genuine fast winner, not noise, and shouldn't have to
// wait to be evaluated for profit-taking just because the clock hasn't run
// out. Comfortably above the ~1-2% fee/gas floor a "flat" position already
// carries (see netOfExitCosts) and above ordinary tick-to-tick wobble, so
// this can't be satisfied by noise alone - only an actual move qualifies.
const EARLY_REVIEW_MIN_GAIN_PCT = 5;
// Even past the floor above, re-reviewing a flat/marginal position on every
// tick (as often as every 90s) doesn't add real information - the
// technicals it's judged on (RSI/MACD/Bollinger) come from 15-minute
// candles, so most of those reviews are re-judging nearly-identical data.
// Asked often enough, ordinary noise eventually produces a "sell" that
// isn't a real signal, just the law of large numbers - a position gets
// asked dozens of times an hour and only needs one unlucky-looking moment.
// Throttling non-gaining reviews to roughly once per candle cuts how many
// chances noise gets, without slowing down real profit-taking, which still
// bypasses this (see the roughGainPct check below).
const MIN_REVIEW_GAP_MINUTES = CANDLE_MINUTES;

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

// Hunter IQ: how much of a vault's own lesson history rides along in a
// personalized AI call - bounded so the prompt doesn't grow without limit as
// a vault accumulates trades.
const LESSON_CONTEXT_LIMIT = 8;
// A realized loss worse than this on a Hunter position is worth the bot
// writing itself a lesson about - most losing closes are just how
// dip-buying goes and aren't actually instructive.
const LOSS_LESSON_THRESHOLD_PCT = -15;
// A token Hunter declined that then ran at least this much afterward is
// worth reflecting on as a real miss, not noise.
const MISS_LESSON_MOVE_PCT = 50;
// Give a declined token time to actually move before judging the decision -
// checking an hour later would just be measuring normal volatility.
const MISS_REVIEW_DELAY_HOURS = 24;
// Don't keep re-checking price on declines older than this - a miss from a
// month ago isn't a fresh lesson anymore.
const MISS_REVIEW_WINDOW_DAYS = 14;
// Cap self-reflection AI calls per tick, so a backlog (first deploy after
// this shipped, or the keeper having been down a while) can't burst-spend
// on a pile of historical closes/misses all at once - it works through the
// backlog gradually instead.
const REFLECTION_BATCH_LIMIT = 5;

// How many of {RSI oversold, bullish MACD cross, Bollinger lower band} have
// to agree before this counts as a real setup at all. One real technical
// signal is real data behind the decision, not a blind buy - it doesn't
// need multiple indicators to agree with each other. See evaluateWatchedToken
// and technicalConfidence() below - confidence still scales with how many
// actually hit, it's just not a requirement to clear the bar at all.
const MIN_AGREEING_SIGNALS = 1;

/** Confidence grounded in something a person can verify - how many
 * independent technical signals actually agree - rather than only the AI's
 * own self-reported word for it. One reliable signal is enough to call it a
 * real setup ("confident"); two or more agreeing is "high" confidence.
 * Never called below MIN_AGREEING_SIGNALS. */
function technicalConfidence(signalCount: number): "confident" | "high" {
  return signalCount >= 2 ? "high" : "confident";
}

interface Strictest {
  requireRsi: boolean; rsiOversold: number;
  requireMacdCross: boolean;
  requireBollinger: boolean; bollingerPercentBMax: number;
  requireVolumeConfirmation: boolean; minVolumeRatio: number;
  minLiquidityPls: number;
  minTrades24h: number;
  maxBuyTaxBps: number; maxSellTaxBps: number;
  requireLpLock: boolean; requireOwnerRenounced: boolean;
  anyRequireAi: boolean;
  // The most generous per-trade ceiling among vaults that require AI
  // approval - handed to assess() as the spending authority to size
  // against. Each vault still clamps to its OWN (possibly stricter)
  // ceiling at dispatch time - see sizeForVault().
  aiCeilingPls: number;
}

/** The stop-loss % to actually bake into a position at open time. ATR-based
 * when the vault opted in and a real ATR reading was available at detection
 * time, clamped to a sane range either way; otherwise the flat configured
 * stopLossPct. Auto Full's mandatory floor is layered on top regardless of
 * which path produced the number - see MANDATORY_MIN_STOP_LOSS_PCT. */
function computeStopLossPct(H: HunterConfig, atrPct: number | null): number {
  let pct = H.stopLossPct;
  if (H.useAtrStop && atrPct !== null && atrPct > 0) {
    pct = Math.min(ATR_STOP_MAX_PCT, Math.max(ATR_STOP_MIN_PCT, atrPct * H.atrStopMultiplier));
  }
  if (H.exitMode === "full") pct = pct > 0 ? pct : MANDATORY_MIN_STOP_LOSS_PCT;
  return pct;
}

async function vaultWplsPls(vault: string): Promise<number> {
  const wpls = new Contract(CFG.wpls, ERC20_ABI, provider) as Dyn;
  return Number(formatEther(await wpls.balanceOf(vault)));
}

function actionsToday(vault: string): number {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const r = db.prepare(`SELECT COUNT(*) n FROM discovery_actions WHERE vault=? AND ts>=?`)
    .get(vault.toLowerCase(), since) as { n: number };
  return r.n;
}

/** How much of its own dedicated allocation this bot currently has
 * deployed, across every vault's open hunter positions. Freed back as
 * positions close (a realized loss shrinks the vault, but frees the same
 * PLS the position was opened with back to the allocation) - allocatedPls
 * caps concurrent exposure, not lifetime spend. */
function deployedPls(vault: string): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(spent_pls),0) s FROM positions WHERE vault=? AND bot='hunter' AND status='open'`,
  ).get(vault.toLowerCase()) as { s: number };
  return r.s;
}

function checkTriggers(
  snap: NonNullable<ReturnType<typeof snapshot>>, strictest: Strictest,
): string[] {
  const hits: string[] = [];
  if (strictest.requireRsi && snap.rsi !== null && snap.rsi <= strictest.rsiOversold)
    hits.push(`RSI ${snap.rsi.toFixed(0)} is oversold (<= ${strictest.rsiOversold})`);
  if (strictest.requireMacdCross && snap.macd?.bullishCross)
    hits.push("MACD just crossed bullish");
  if (strictest.requireBollinger && snap.bollinger !== null && snap.bollinger.percentB <= strictest.bollingerPercentBMax)
    hits.push(`Bollinger %B ${snap.bollinger.percentB.toFixed(2)} is riding the lower band`);
  return hits;
}

function buildNarrative(symbol: string, triggers: string[], s: DiscoveryScreen, ai: AiVerdict | null, volRatio: number | null): string {
  const volNote = volRatio !== null && Number.isFinite(volRatio)
    ? ` Recent volume is running ${volRatio.toFixed(1)}x its baseline.`
    : "";
  const conf = technicalConfidence(triggers.length);
  const confidenceNote = conf === "high"
    ? ` ${triggers.length} technical signals agree - high confidence.`
    : " One technical signal.";
  const base = `${symbol} looks oversold: ${triggers.join("; ")}.${confidenceNote}${volNote}`;
  if (s.verdict !== "pass") return `${base} Screen failed: ${s.reason}.`;
  const screened = `${base} Passed the same honeypot, tax, LP-lock and renounce screen the Launch Bot runs.`;
  if (!ai) return screened;
  return `${screened} AI take (${ai.confidence} confidence, ${ai.recommend ? "would buy" : "would not buy"}): ${ai.reasoning}`;
}

/**
 * `amountPls` is decided by the caller, not read from H.maxPerTradePls
 * directly - when the AI sized the trade (see ai.ts's assess()), this is
 * its suggested amount, clamped to this vault's own ceiling; otherwise it's
 * the full ceiling. Either way `amountPls` here is the actual spend, never
 * exceeding H.maxPerTradePls.
 */
async function executeHunterBuy(v: VaultRecord, id: number, token: string, amountPls: number, atrPct: number | null): Promise<void> {
  const H = v.hunter;
  if (amountPls <= 0 || H.allocatedPls <= 0) return;

  const deployed = deployedPls(v.address);
  if (deployed + amountPls > H.allocatedPls) {
    log("info", "hunter", `${v.address} ${token}: ${amountPls} PLS would exceed its ${H.allocatedPls} PLS allocation (${deployed} already deployed), skipping`);
    return;
  }

  // The general vault-wide holding cap still applies too, in addition to
  // this bot's own budget - defense in depth, same as every other bot here.
  const { total: posValue, byToken } = await positionsValuePls(v.address);
  const totalValue = (await vaultWplsPls(v.address)) + posValue;
  const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
  if (exceedsHoldingCap(tokenNow + amountPls, totalValue, v.maxHoldingPct)) {
    log("info", "hunter", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping buy`);
    return;
  }

  const amountIn = parseEther(String(amountPls));
  const res = await executeSwap({
    vault: v.address, bot: "hunter", path: [CFG.wpls, token], amountIn, tokenLabel: token,
    slippageBps: Math.min(CFG.maxSlippageBps, 300),
  });

  if (res.ok) {
    // Auto Full: the AI takes over deciding when to exit (see
    // reviewFullModePositions), so the fixed take-profit/trailing/time
    // targets don't apply - only the stop-loss does, and it's never
    // actually disabled even if it resolved to 0 or wasn't set.
    const slPct = computeStopLossPct(H, atrPct);
    openPosition({
      vault: v.address, bot: "hunter", token,
      spentPls: amountPls, tokensOut: res.amountOut,
      tpPct: H.exitMode === "full" ? 0 : H.takeProfitPct,
      slPct,
      trailPct: H.exitMode === "full" ? 0 : H.trailingStopPct,
      timeExitMin: H.exitMode === "full" ? 0 : H.timeExitMin,
      exitMode: H.exitMode,
      // Needed to find this trade's own buy narrative later - see
      // reflectOnClosedLosses below, which has nothing to reflect on
      // without it.
      sourceTxHash: res.txHash,
    });
    discoveryActions.record(v.address, id, "bought", res.txHash);
    log("info", "hunter", `${v.address} bought ${amountPls} PLS of ${token} on opportunity #${id}`);
  } else {
    log("warn", "hunter", `${v.address} skipped opportunity #${id} (${token}): ${res.reason}`);
  }
}

/** How much to actually spend for this vault: the AI's own sizing when it
 * gave one, clamped to this vault's ceiling (never more, even if the AI's
 * ceiling at call time was a looser vault's), otherwise the full ceiling. */
function sizeForVault(H: HunterConfig, ai: AiVerdict | null): number {
  if (ai?.suggestedAmountPls) return Math.min(ai.suggestedAmountPls, H.maxPerTradePls);
  return H.maxPerTradePls;
}

/**
 * Hunter IQ's actual personalization point. A vault with no lessons yet
 * keeps sharing the one AI call computed for this opportunity (see
 * evaluateWatchedToken) - the shared-call cost model every other subscriber
 * relies on stays unchanged for them. Only once a vault has its own
 * owner-typed feedback or self-written lessons does it get its own call,
 * weighing its own history and its own spending ceiling instead of the
 * loosest shared one. If the personalized call itself fails (rate limit,
 * API outage), falls back to the shared verdict rather than losing AI
 * review outright for a vault that was otherwise entitled to it.
 */
async function personalizedOrSharedAi(v: VaultRecord, sharedAi: AiVerdict | null, profile: TokenProfile | null): Promise<AiVerdict | null> {
  if (!profile || !hunterLessons.hasAny(v.address)) return sharedAi;
  const guidance = hunterLessons.recentForVault(v.address, LESSON_CONTEXT_LIMIT).map((l) => l.text);
  const personal = await assess(profile, v.hunter.maxPerTradePls, guidance);
  return personal ?? sharedAi;
}

async function dispatch(
  id: number, token: string, ai: AiVerdict | null, s: DiscoveryScreen, atrPct: number | null, candidates: VaultRecord[],
  profile: TokenProfile | null,
): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const H = v.hunter;
    if (s.buyTaxBps > H.maxBuyTaxBps) return;
    if (s.sellTaxBps > H.maxSellTaxBps) return;
    if (H.requireLpLock && s.lpLockedPct < 95) return;
    if (H.requireOwnerRenounced && !s.ownerRenounced) return;
    if (discoveryActions.has(v.address, id)) return;
    if (actionsToday(v.address) >= H.maxPerDay) return;

    if (H.mode === "notify") {
      discoveryActions.record(v.address, id, "notified");
      log("info", "hunter", `${v.address} notified of opportunity #${id} (${token})`);
      return;
    }

    let vAi = ai;
    if (H.requireAiApproval) {
      vAi = await personalizedOrSharedAi(v, ai, profile);
      if (!vAi) {
        log("info", "hunter", `${v.address} ${token}: AI approval required but unavailable, notifying instead of buying`);
        discoveryActions.record(v.address, id, "notified");
        return;
      }
      if (!vAi.recommend || CONFIDENCE_RANK[vAi.confidence] < CONFIDENCE_RANK[H.minAiConfidence]) {
        log("info", "hunter", `${v.address} ${token}: AI did not clear the bar (recommend=${vAi.recommend}, confidence=${vAi.confidence}), notifying instead of buying`);
        discoveryActions.record(v.address, id, "notified");
        return;
      }
    }

    await executeHunterBuy(v, id, token, sizeForVault(H, vAi), atrPct);
  });
}

async function evaluateWatchedToken(
  w: { token: string; symbol: string; pair: string },
  strictest: Strictest, from: number, dedupSince: number, candidates: VaultRecord[],
): Promise<void> {
  if (opportunities.recentForToken(w.token, dedupSince)) return;

  const candles = candlesForToken(w.token, from, CANDLE_MINUTES * 60);
  if (candles.length < MIN_CANDLES) return;

  const snap = snapshot(candles);
  if (!snap) return;

  const triggers = checkTriggers(snap, strictest);
  // A single indicator alone (RSI oversold on its own, say) is too easy to
  // hit on noise - real conviction is when independent signals agree.
  // Below this, it's not treated as a setup worth screening at all, let
  // alone buying.
  if (triggers.length < MIN_AGREEING_SIGNALS) return;

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  if (last.liq < strictest.minLiquidityPls) return;

  // Confirmation gate, not an alternative trigger: an RSI/MACD/Bollinger
  // reading on a token nobody is actually trading isn't trustworthy on its
  // own. Skipped entirely (not recorded) rather than shown as a rejected
  // opportunity - unlike the liquidity-pull check below, "not enough volume
  // yet" isn't itself an interesting finding, it just means try again later.
  if (strictest.requireVolumeConfirmation && (snap.volRatio === null || snap.volRatio < strictest.minVolumeRatio)) return;

  // Liveness gate: is this token actually being traded, at all, right now -
  // as opposed to sitting still with one stale trade from days ago that
  // happens to leave the price looking "oversold" with nothing behind it.
  // A token this young can't have a full 24h of coverage yet, so this
  // extrapolates from whatever's actually available in the last day rather
  // than requiring a complete window - MIN_CANDLES above already guarantees
  // at least 9 hours of real data by this point, enough for a reasonable
  // estimate without making every freshly-watched token wait a full day.
  if (strictest.minTrades24h > 0) {
    const dayAgo = Math.floor(Date.now() / 1000) - 24 * 3600;
    const recent = candles.filter((c) => c.ts >= dayAgo);
    const tradesRecent = recent.reduce((sum, c) => sum + c.trades, 0);
    const hoursAvailable = recent.length ? Math.max(1, (Math.floor(Date.now() / 1000) - recent[0]!.ts) / 3600) : 0;
    const trades24hEquivalent = hoursAvailable > 0 ? (tradesRecent / hoursAvailable) * 24 : 0;
    if (trades24hEquivalent < strictest.minTrades24h) return;
  }

  // Hard gate, not configurable - the exact trap this bot exists to avoid.
  // Recorded and shown rather than silently dropped, same as a failed
  // screen: seeing "this looked oversold but liquidity looks pulled" is
  // itself useful, not noise.
  if (liquidityDropIsSuspicious(first.close, last.close, first.liq, last.liq)) {
    const id = opportunities.insert({
      token: w.token, priceMovePct: ((last.close - first.close) / first.close) * 100,
      liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100, liqPls: last.liq,
      buyTaxBps: null, sellTaxBps: null, lpLockedPct: null, ownerRenounced: null, sellable: false,
      verdict: "fail", reason: "liquidity fell far more than the price move explains - looks like LP was pulled, not organic selling",
      narrative: `${w.symbol} looks oversold (${triggers.join("; ")}) but its liquidity dropped more than the price move alone would explain - this looks like a liquidity pull, not a real dip. Skipped.`,
      source: "hunter", rsi: snap.rsi, macdHistogram: snap.macd?.histogram ?? null, bollingerPercentB: snap.bollinger?.percentB ?? null,
      signalCount: triggers.length,
    });
    log("warn", "hunter", `Opportunity #${id}: ${w.symbol} rejected - liquidity pull signature, not a real dip`);
    return;
  }

  const s = await screenOpportunity(w.token, w.pair, strictest);

  let ai: AiVerdict | null = null;
  let profile: TokenProfile | null = null;
  if (s.verdict === "pass" && strictest.anyRequireAi) {
    profile = {
      symbol: w.symbol, token: w.token, liqPls: last.liq,
      buyTaxBps: s.buyTaxBps, sellTaxBps: s.sellTaxBps, lpLockedPct: s.lpLockedPct,
      deployerPct: null, ownerRenounced: s.ownerRenounced, roundTripLossBps: s.roundTripLossBps,
      priceMovePct: ((last.close - first.close) / first.close) * 100,
      liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100,
      rsi: snap.rsi, macdHistogram: snap.macd?.histogram ?? null,
      macdBullishCross: snap.macd?.bullishCross ?? null, bollingerPercentB: snap.bollinger?.percentB ?? null,
      atrPct: snap.atrPct, volRatio: snap.volRatio,
      narrative: `Technical setup: ${triggers.join("; ")}`,
    };
    ai = await assess(profile, strictest.aiCeilingPls > 0 ? strictest.aiCeilingPls : undefined);
  }

  const narrative = buildNarrative(w.symbol, triggers, s, ai, snap.volRatio);
  const id = opportunities.insert({
    token: w.token, priceMovePct: ((last.close - first.close) / first.close) * 100,
    liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100, liqPls: last.liq,
    buyTaxBps: s.buyTaxBps, sellTaxBps: s.sellTaxBps, lpLockedPct: s.lpLockedPct,
    ownerRenounced: s.ownerRenounced, sellable: s.sellable, verdict: s.verdict, reason: s.reason, narrative,
    source: "hunter", rsi: snap.rsi, macdHistogram: snap.macd?.histogram ?? null, bollingerPercentB: snap.bollinger?.percentB ?? null,
    aiRecommend: ai?.recommend ?? null, aiConfidence: ai?.confidence ?? null, aiReasoning: ai?.reasoning ?? null,
    aiSuggestedAmountPls: ai?.suggestedAmountPls ?? null,
    atrPct: snap.atrPct, volRatio: snap.volRatio, signalCount: triggers.length,
  });
  log("info", "hunter", `Opportunity #${id}: ${narrative}`);

  if (s.verdict !== "pass") return;
  await dispatch(id, w.token, ai, s, snap.atrPct, candidates, profile);
}

interface FullModeRow {
  id: number; vault: string; token: string; opened_at: number; entry_price: number;
  spent_pls: number; high_water: number; last_ai_review_at: number | null;
}

/**
 * Auto Full's periodic re-judgment - every open Hunter position whose owner
 * chose "full" exit authority gets asked, on the same cadence as detection,
 * whether it's still worth holding. A "sell" verdict is recorded as an AI
 * exit request (see db.ts's aiExitRequests); positions.ts's own tick()
 * picks that up and executes the sell exactly like an owner-requested
 * manual close, on its own faster cadence. Never the only thing standing
 * between a position and ruin - the mandatory stop-loss set at buy time
 * (see executeHunterBuy) still applies underneath this regardless of what
 * the AI decides here.
 */
async function reviewFullModePositions(): Promise<void> {
  const rows = db.prepare(
    `SELECT id, vault, token, opened_at, entry_price, spent_pls, high_water, last_ai_review_at
     FROM positions WHERE bot='hunter' AND status='open' AND exit_mode='full'`,
  ).all() as FullModeRow[];
  if (rows.length === 0) return;

  const from = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  const symbolByToken = new Map(watched.all().map((w) => [w.token, w.symbol]));

  await mapLimit(rows, CFG.keeperConcurrency, async (r) => {
    try {
      const latest = prices.latest(r.token);
      if (!latest || latest.price <= 0 || r.entry_price <= 0) return;

      // prices.latest() is a raw AMM mid-price (see prices.ts's readPair) -
      // it has no idea this token might take a cut on transfer, so it always
      // overstates what a real sale would return. Discounted by the same
      // measured sell_tax_bps positions.ts's markToMarket uses, so the AI
      // isn't judging an exit against a price nobody could actually realize -
      // exactly the mismatch that let it believe a position was up when
      // closing it actually locked in a loss.
      const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
        .get(r.token.toLowerCase()) as { sell_tax_bps: number } | undefined;
      const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
      const taxAdjustedPrice = latest.price * (1 - taxBps / 10_000);

      // See MIN_HOLD_MINUTES_BEFORE_AI_REVIEW's comment - a young position
      // hasn't had time to show a real setup yet, so below that age the AI
      // isn't consulted UNLESS it's already sitting on a real gain worth
      // looking at. A genuine fast winner should still get evaluated for
      // profit-taking right away, same as the owner asked for - this only
      // holds back the case that actually caused the problem: a position
      // that's flat or only marginally up/down this early, which is normal
      // unresolved noise, not a signal either way. Uses the cheap raw quote
      // (no RPC round trip) since this is a threshold check, not the number
      // handed to the AI - real fee/gas costs below only ever push the real
      // number down from here, so this can't let a not-actually-a-gain
      // position through.
      const nowSec = Math.floor(Date.now() / 1000);
      const minutesHeldSoFar = (nowSec - r.opened_at) / 60;
      const roughGainPct = ((taxAdjustedPrice - r.entry_price) / r.entry_price) * 100;
      const isRealGain = roughGainPct >= EARLY_REVIEW_MIN_GAIN_PCT;
      if (minutesHeldSoFar < MIN_HOLD_MINUTES_BEFORE_AI_REVIEW && !isRealGain) return;

      // Past the floor, a flat/marginal position still shouldn't be
      // re-asked every single tick forever - see MIN_REVIEW_GAP_MINUTES's
      // comment. A real gain always bypasses this, same reasoning as the
      // early-review exception above: profit-taking should never wait on a
      // throttle timer.
      const minutesSinceLastReview = r.last_ai_review_at === null
        ? Infinity : (nowSec - r.last_ai_review_at) / 60;
      if (!isRealGain && minutesSinceLastReview < MIN_REVIEW_GAP_MINUTES) return;

      // Still a raw market price - a real close also pays the platform fee
      // and gas reimbursement (see executor.ts's netOfExitCosts), which
      // this AI judgment had no visibility into. Converts to a total value
      // at the position's own size (spent_pls/entry_price backs out the
      // token quantity without needing a separate decimals lookup - same
      // relationship openPosition used to derive entry_price in the first
      // place), nets out the real exit costs, then converts back to a
      // per-token price so pnlPct/currentPrice reflect what the position
      // would actually realize, not what the market alone would pay.
      const tokensHeldApprox = r.spent_pls / r.entry_price;
      const realizablePrice = tokensHeldApprox > 0
        ? (await netOfExitCosts(taxAdjustedPrice * tokensHeldApprox, r.vault)) / tokensHeldApprox
        : taxAdjustedPrice;

      const candles = candlesForToken(r.token, from, CANDLE_MINUTES * 60);
      const snap = candles.length ? snapshot(candles) : null;

      const context: OpenPositionContext = {
        symbol: symbolByToken.get(r.token) ?? r.token,
        token: r.token,
        entryPrice: r.entry_price,
        currentPrice: realizablePrice,
        pnlPct: ((realizablePrice - r.entry_price) / r.entry_price) * 100,
        peakPnlPct: (r.high_water - 1) * 100, // high_water is a value/cost ratio - 1.0 is breakeven
        minutesHeld: minutesHeldSoFar,
        rsi: snap?.rsi ?? null,
        macdHistogram: snap?.macd?.histogram ?? null,
        macdBullishCross: snap?.macd?.bullishCross ?? null,
        macdBearishCross: snap?.macd?.bearishCross ?? null,
        bollingerPercentB: snap?.bollinger?.percentB ?? null,
        atrPct: snap?.atrPct ?? null,
        volRatio: snap?.volRatio ?? null,
      };

      const verdict = await assessExit(context);
      db.prepare("UPDATE positions SET last_ai_review_at = ? WHERE id = ?").run(nowSec, r.id);
      if (verdict?.sell) {
        aiExitRequests.request(r.id, verdict.reasoning);
        log("info", "hunter", `Position #${r.id} (${context.symbol}): AI exit judgment - ${verdict.reasoning}`);
      }
    } catch (e) {
      log("error", "hunter", `Exit review for position #${r.id}: ${(e as Error).message}`);
    }
  });
}

interface FetchedFeedback { id: number; text: string }

/** Owner-typed Hunter IQ feedback, pending on the site's side - same
 * "site writes an intent, keeper picks it up" split as fetchBuyRequests. */
async function fetchOwnerFeedback(vault: string): Promise<FetchedFeedback[]> {
  const api = process.env.CONFIG_API;
  if (!api) return [];
  try {
    const res = await fetch(`${api}/vaults/${vault}/hunter-feedback-requests`);
    if (!res.ok) return [];
    return (await res.json()) as FetchedFeedback[];
  } catch (e) {
    log("warn", "hunter", `Feedback fetch failed for ${vault}: ${(e as Error).message}`);
    return [];
  }
}

async function ingestOwnerFeedback(candidates: VaultRecord[]): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const requests = await fetchOwnerFeedback(v.address);
    for (const r of requests) {
      if (hunterLessons.alreadyIngestedOwnerRequest(v.address, r.id)) continue;
      hunterLessons.add(v.address, "owner", r.text, { ownerRequestId: r.id });
      log("info", "hunter", `${v.address}: new Hunter IQ feedback recorded (request #${r.id})`);
    }
  });
}

interface ClosedHunterPositionRow {
  id: number; vault: string; token: string; spent_pls: number; proceeds_pls: number | null;
  close_reason: string | null; opened_at: number; closed_at: number | null; source_tx_hash: string | null;
}

/**
 * Hunter IQ's self-reflection on its own losing trades. Every Hunter close
 * gets looked at exactly once (see hunterLessons.closeAlreadyReviewed/
 * markCloseReviewed) - most are ignored (small wins, near-flat closes
 * aren't instructive), and only a real loss past LOSS_LESSON_THRESHOLD_PCT
 * triggers an AI call to actually write a lesson. Runs on the same cadence
 * as detection since it's cheap to check and naturally rate-limited by
 * REFLECTION_BATCH_LIMIT.
 */
async function reflectOnClosedLosses(): Promise<void> {
  const rows = db.prepare(`
    SELECT id, vault, token, spent_pls, proceeds_pls, close_reason, opened_at, closed_at, source_tx_hash
    FROM positions WHERE bot='hunter' AND status IN ('closed','stuck')
  `).all() as ClosedHunterPositionRow[];
  if (rows.length === 0) return;

  const symbolByToken = new Map(watched.all().map((w) => [w.token, w.symbol]));
  let processed = 0;
  for (const r of rows) {
    if (processed >= REFLECTION_BATCH_LIMIT) break;
    if (hunterLessons.closeAlreadyReviewed(r.id)) continue;
    processed++;

    if (r.proceeds_pls === null || !r.spent_pls) { hunterLessons.markCloseReviewed(r.id); continue; }
    const pnlPct = (r.proceeds_pls / r.spent_pls - 1) * 100;
    if (pnlPct > LOSS_LESSON_THRESHOLD_PCT) { hunterLessons.markCloseReviewed(r.id); continue; }

    try {
      // The opportunity that led to this buy, for its narrative - linked via
      // the tx that opened it (see positions.ts's OpenArgs.sourceTxHash and
      // executeHunterBuy above). A position opened before that link existed
      // just gets a generic note instead of failing outright.
      let buyNarrative = "no detection narrative on file for this trade";
      if (r.source_tx_hash) {
        const action = db.prepare("SELECT opportunity_id FROM discovery_actions WHERE vault=? AND tx_hash=? AND action='bought'")
          .get(r.vault, r.source_tx_hash) as { opportunity_id: number } | undefined;
        if (action) {
          const opp = opportunities.get(action.opportunity_id);
          if (opp) buyNarrative = opp.narrative;
        }
      }

      const symbol = symbolByToken.get(r.token) ?? r.token;
      const lesson = await reflectOnLoss({
        symbol, token: r.token, buyNarrative,
        closeReason: r.close_reason ?? "unknown", pnlPct,
        heldMinutes: r.closed_at ? (r.closed_at - r.opened_at) / 60 : 0,
      });
      if (lesson) {
        hunterLessons.add(r.vault, "self_loss", lesson, { positionId: r.id });
        log("info", "hunter", `${r.vault}: self-reflection on position #${r.id} (${symbol}) - ${lesson}`);
      }
    } catch (e) {
      log("error", "hunter", `Loss reflection for position #${r.id}: ${(e as Error).message}`);
    } finally {
      hunterLessons.markCloseReviewed(r.id);
    }
  }
}

const AUTO_REBUY_BATCH_LIMIT = 5;

interface RebuyCandidateRow {
  id: number; vault: string; token: string; entry_price: number; spent_pls: number;
  proceeds_pls: number | null; close_reason: string | null;
}

/**
 * After a Hunter position closes on a bearish/profit-taking read, queue a
 * resting rebuy for the same token some percent below the exit price - a
 * real pullback becomes a better entry instead of the bot just walking
 * away. Only for a vault that opted in (registry.ts's autoRebuyOnExit) and
 * only for a close reason that means "the bot chose to take this off,"
 * never a stop-loss (the thesis was wrong, not a reason to want back in) or
 * an owner-requested manual close (they wanted out, not "buy it back for
 * me"). See db.ts's pendingRebuys for why this lives entirely on the
 * keeper's own side rather than as a real limitOrders entry.
 */
async function considerAutoRebuys(): Promise<void> {
  const rows = db.prepare(`
    SELECT id, vault, token, entry_price, spent_pls, proceeds_pls, close_reason
    FROM positions WHERE bot='hunter' AND status='closed'
  `).all() as RebuyCandidateRow[];
  if (rows.length === 0) return;

  let processed = 0;
  for (const r of rows) {
    if (processed >= AUTO_REBUY_BATCH_LIMIT) break;
    if (pendingRebuys.rebuyAlreadyConsidered(r.id)) continue;
    processed++;

    const v = registry.get(r.vault);
    const H = v?.hunter;
    if (!H || !H.autoRebuyOnExit) { pendingRebuys.markRebuyConsidered(r.id); continue; }

    const reason = r.close_reason ?? "";
    const qualifies = reason.startsWith("AI exit") || reason.startsWith("take profit") || reason.startsWith("trailing stop");
    if (!qualifies) { pendingRebuys.markRebuyConsidered(r.id); continue; }

    if (r.proceeds_pls === null || r.proceeds_pls <= 0 || r.entry_price <= 0 || r.spent_pls <= 0) {
      pendingRebuys.markRebuyConsidered(r.id);
      continue;
    }

    // Same relationship openPosition used to derive entry_price in the
    // first place - backs out the token quantity that was sold without
    // needing a separate decimals lookup.
    const tokensSold = r.spent_pls / r.entry_price;
    if (tokensSold <= 0) { pendingRebuys.markRebuyConsidered(r.id); continue; }
    const exitPrice = r.proceeds_pls / tokensSold;
    const targetPrice = exitPrice * (1 - H.autoRebuyDipPct / 100);
    const amountPls = H.maxPerTradePls > 0 ? Math.min(r.spent_pls, H.maxPerTradePls) : r.spent_pls;
    const expiresAt = Math.floor(Date.now() / 1000) + H.autoRebuyExpireHours * 3600;

    pendingRebuys.insert(r.vault, r.token, targetPrice, amountPls, r.id, expiresAt);
    pendingRebuys.markRebuyConsidered(r.id);
    log("info", "hunter", `${r.vault}: queued an auto-rebuy for ${r.token} if it drops to ${targetPrice.toFixed(10)} (${H.autoRebuyDipPct}% below its ${exitPrice.toFixed(10)} exit), expires in ${H.autoRebuyExpireHours}h`);
  }
}

/**
 * Fires any pending auto-rebuy whose target has been reached, or drops it
 * once it's expired without one. Uses prices.latest() rather than a fresh
 * quote - this token is already watched, so that data is kept fresh
 * regardless - discounted by the same measured sell_tax_bps every other
 * Hunter price read uses. Re-checks the vault's CURRENT settings at fire
 * time, not whatever they were when the rebuy was queued: if the owner has
 * since turned Hunter or auto-rebuy off, or lowered the per-trade ceiling,
 * a stale queued rebuy respects that, not the settings from whenever the
 * original position closed. Mirrors executeHunterBuy's allocation/holding-
 * cap checks and how it opens the resulting position, since this is still
 * an ordinary Hunter buy in every way that matters - it just wasn't found
 * through the normal RSI/MACD/Bollinger detection pass.
 */
async function checkPendingRebuys(): Promise<void> {
  const pending = pendingRebuys.all();
  if (pending.length === 0) return;
  const now = Math.floor(Date.now() / 1000);

  await mapLimit(pending, CFG.keeperConcurrency, async (p) => {
    if (now >= p.expiresAt) {
      pendingRebuys.remove(p.id);
      log("info", "hunter", `${p.vault}: auto-rebuy for ${p.token} expired without filling`);
      return;
    }

    const v = registry.get(p.vault);
    const H = v?.hunter;
    if (!v || !H || !H.enabled || !H.autoRebuyOnExit) { pendingRebuys.remove(p.id); return; }

    const latest = prices.latest(p.token);
    if (!latest || latest.price <= 0) return; // try again next tick

    const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
      .get(p.token.toLowerCase()) as { sell_tax_bps: number } | undefined;
    const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
    const taxAdjustedPrice = latest.price * (1 - taxBps / 10_000);
    if (taxAdjustedPrice > p.targetPrice) return; // hasn't dropped far enough yet

    const amountPls = H.maxPerTradePls > 0 ? Math.min(p.amountPls, H.maxPerTradePls) : p.amountPls;
    if (amountPls <= 0 || H.allocatedPls <= 0) { pendingRebuys.remove(p.id); return; }

    const deployed = deployedPls(v.address);
    if (deployed + amountPls > H.allocatedPls) return; // try again next tick - allocation may free up

    const { total: posValue, byToken } = await positionsValuePls(v.address);
    const totalValue = (await vaultWplsPls(v.address)) + posValue;
    const tokenNow = byToken.get(p.token.toLowerCase()) ?? 0;
    if (exceedsHoldingCap(tokenNow + amountPls, totalValue, v.maxHoldingPct)) return; // try again next tick

    try {
      const res = await executeSwap({
        vault: p.vault, bot: "hunter", path: [CFG.wpls, p.token],
        amountIn: parseEther(String(amountPls)), tokenLabel: p.token,
        slippageBps: Math.min(CFG.maxSlippageBps, 300),
      });
      if (!res.ok) {
        log("warn", "hunter", `${p.vault}: auto-rebuy for ${p.token} failed to fill: ${res.reason}`);
        return; // transient - try again next tick rather than dropping a real opportunity
      }
      const slPct = computeStopLossPct(H, null);
      openPosition({
        vault: p.vault, bot: "hunter", token: p.token,
        spentPls: amountPls, tokensOut: res.amountOut,
        tpPct: H.exitMode === "full" ? 0 : H.takeProfitPct,
        slPct,
        trailPct: H.exitMode === "full" ? 0 : H.trailingStopPct,
        timeExitMin: H.exitMode === "full" ? 0 : H.timeExitMin,
        exitMode: H.exitMode,
        sourceTxHash: res.txHash,
      });
      pendingRebuys.remove(p.id);
      log("info", "hunter", `${p.vault}: auto-rebuy filled for ${p.token} at ${amountPls} PLS, tx=${res.txHash}`);
    } catch (e) {
      log("error", "hunter", `Auto-rebuy execution for ${p.token} on ${p.vault}: ${(e as Error).message}`);
    }
  });
}

interface DeclinedOpportunityRow {
  id: number; token: string; ts: number; narrative: string; aiReasoning: string | null; priceAtDetection: number | null;
}

/**
 * Hunter IQ's self-reflection on its own declines - a candidate that passed
 * the mechanical screen but the AI gate turned down, checked back after
 * MISS_REVIEW_DELAY_HOURS to see if it actually ran without the bot. Only a
 * real, sizeable move (MISS_LESSON_MOVE_PCT) is worth an AI call; most
 * declines just never go anywhere, which isn't a miss, it's the decline
 * working as intended. A lesson from this only goes to vaults that actually
 * saw this opportunity declined (see discoveryActions) - a vault that never
 * subscribed to it has nothing to learn from a call it wasn't party to.
 */
async function reflectOnMissedOpportunities(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const reviewFrom = now - MISS_REVIEW_WINDOW_DAYS * 86400;
  const reviewUntil = now - MISS_REVIEW_DELAY_HOURS * 3600;
  const rows = db.prepare(`
    SELECT id, token, ts, narrative, ai_reasoning AS aiReasoning, price_at_detection AS priceAtDetection
    FROM opportunities
    WHERE source='hunter' AND verdict='pass' AND ai_recommend=0 AND ts >= ? AND ts <= ?
  `).all(reviewFrom, reviewUntil) as DeclinedOpportunityRow[];
  if (rows.length === 0) return;

  const symbolByToken = new Map(watched.all().map((w) => [w.token, w.symbol]));
  let processed = 0;
  for (const r of rows) {
    if (processed >= REFLECTION_BATCH_LIMIT) break;
    if (hunterLessons.missAlreadyReviewed(r.id)) continue;
    processed++;

    if (r.priceAtDetection === null || r.priceAtDetection <= 0) { hunterLessons.markMissReviewed(r.id); continue; }
    const latest = prices.latest(r.token);
    if (!latest || latest.price <= 0) { hunterLessons.markMissReviewed(r.id); continue; }

    const movePct = ((latest.price - r.priceAtDetection) / r.priceAtDetection) * 100;
    if (movePct < MISS_LESSON_MOVE_PCT) { hunterLessons.markMissReviewed(r.id); continue; }

    const vaults = db.prepare("SELECT DISTINCT vault FROM discovery_actions WHERE opportunity_id=?").all(r.id) as { vault: string }[];
    if (vaults.length === 0) { hunterLessons.markMissReviewed(r.id); continue; }

    try {
      const symbol = symbolByToken.get(r.token) ?? r.token;
      const lesson = await reflectOnMiss({
        symbol, token: r.token,
        detectionNarrative: r.narrative, declineReason: r.aiReasoning ?? "declined (no AI reasoning on file)",
        movePctSinceDeclined: movePct, daysSinceDeclined: (now - r.ts) / 86400,
      });
      if (lesson) {
        for (const { vault } of vaults) hunterLessons.add(vault, "self_miss", lesson, { opportunityId: r.id });
        log("info", "hunter", `Self-reflection on missed opportunity #${r.id} (${symbol}) - ${lesson}`);
      }
    } catch (e) {
      log("error", "hunter", `Miss reflection for opportunity #${r.id}: ${(e as Error).message}`);
    } finally {
      hunterLessons.markMissReviewed(r.id);
    }
  }
}

async function processHunterBuyRequests(candidates: VaultRecord[]): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const requests = await fetchBuyRequests(v.address);
    for (const { id, amountPls: requestedAmountPls } of requests) {
      if (discoveryActions.actionFor(v.address, id) === "bought") continue;
      const opp = opportunities.get(id);
      if (!opp || opp.verdict !== "pass" || opp.source !== "hunter") continue;
      try {
        // The owner typed their own amount in on the site - still clamped
        // to this vault's own per-trade ceiling, same protection an autoBuy
        // gets. Without one (a request made before that existed), fall back
        // to the AI's suggested sizing from detection time, or the full
        // ceiling if no AI ran (requireAiApproval was off at detection time).
        const amountPls = requestedAmountPls
          ? Math.min(requestedAmountPls, v.hunter.maxPerTradePls)
          : opp.aiSuggestedAmountPls
          ? Math.min(opp.aiSuggestedAmountPls, v.hunter.maxPerTradePls)
          : v.hunter.maxPerTradePls;
        await executeHunterBuy(v, id, opp.token, amountPls, opp.atrPct ?? null);
      } catch (e) {
        log("error", "hunter", `${v.address} buy request for opportunity #${id}: ${(e as Error).message}`);
      }
    }
  });
}

export async function tick(): Promise<void> {
  // Independent of whether Hunter Bot is still enabled anywhere - an
  // already-open Auto Full position stays actively managed even if the
  // owner later turns the bot off, same as positions.ts's own tick()
  // manages every open position regardless of any bot's current config.
  await reviewFullModePositions();

  // Hunter IQ likewise runs regardless of whether Hunter is currently
  // enabled on any vault - an owner can still leave feedback (or the bot
  // still reflect on an already-closed trade) while it's turned off, so
  // it's ready the moment they turn it back on. Must run before the
  // enabled-candidates early return below, not after.
  await ingestOwnerFeedback(registry.active());
  await reflectOnClosedLosses();
  await reflectOnMissedOpportunities();

  // Same "runs regardless of whether Hunter is enabled anywhere right now"
  // reasoning as the reflection passes above - an already-queued rebuy (or
  // one from a position that just closed) shouldn't stall just because
  // detection is skipped this tick.
  await considerAutoRebuys();
  await checkPendingRebuys();

  const candidates = registry.active().filter((v) => v.hunter.enabled);
  if (candidates.length === 0) return;

  // Same "screen once with the loosest bar any subscriber uses" shape
  // discovery.ts and launch.ts use for their own per-token checks.
  const rsiSubs = candidates.filter((c) => c.hunter.requireRsi);
  const bollSubs = candidates.filter((c) => c.hunter.requireBollinger);
  const volSubs = candidates.filter((c) => c.hunter.requireVolumeConfirmation);
  const aiSubs = candidates.filter((c) => c.hunter.requireAiApproval);
  const strictest: Strictest = {
    requireRsi: rsiSubs.length > 0,
    rsiOversold: rsiSubs.length ? Math.max(...rsiSubs.map((c) => c.hunter.rsiOversold)) : 0,
    requireMacdCross: candidates.some((c) => c.hunter.requireMacdCross),
    requireBollinger: bollSubs.length > 0,
    bollingerPercentBMax: bollSubs.length ? Math.max(...bollSubs.map((c) => c.hunter.bollingerPercentBMax)) : 0,
    requireVolumeConfirmation: volSubs.length > 0,
    // Lower = easier to pass, so the loosest shared bar is the SMALLEST
    // minVolumeRatio among subscribers - the opposite direction from
    // bollingerPercentBMax above, where a bigger number is the looser one.
    minVolumeRatio: volSubs.length ? Math.min(...volSubs.map((c) => c.hunter.minVolumeRatio)) : 0,
    minLiquidityPls: Math.min(...candidates.map((c) => c.hunter.minLiquidityPls)),
    minTrades24h: Math.min(...candidates.map((c) => c.hunter.minTrades24h)),
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.hunter.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.hunter.maxSellTaxBps)),
    // Always false here, NOT candidates.every(...) - that was a real bug.
    // The shared screen only decides pass/fail ONCE for every vault (see
    // evaluateWatchedToken's `if (s.verdict !== "pass") return`), so gating
    // it on "every vault wants LP lock" meant a single vault still requiring
    // it silently blocked the opportunity for every OTHER vault too, even
    // ones that had turned the requirement off. screenOpportunity always
    // computes the real lpLockedPct/ownerRenounced regardless of this flag -
    // dispatch() below already re-checks each vault's own H.requireLpLock/
    // H.requireOwnerRenounced against that real data, which is the only
    // place this decision should actually happen, per-vault.
    requireLpLock: false,
    requireOwnerRenounced: false,
    anyRequireAi: aiSubs.length > 0,
    aiCeilingPls: aiSubs.length ? Math.max(...aiSubs.map((c) => c.hunter.maxPerTradePls)) : 0,
  };

  const from = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  const dedupSince = Math.floor(Date.now() / 1000) - DEDUP_HOURS * 3600;

  for (const w of watched.all()) {
    try {
      await evaluateWatchedToken(w, strictest, from, dedupSince, candidates);
    } catch (e) {
      log("error", "hunter", `${w.token}: ${(e as Error).message}`);
    }
  }

  await processHunterBuyRequests(candidates);
}

export type { HunterConfig };
