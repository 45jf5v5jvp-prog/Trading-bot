import { parseEther, Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type VaultRecord, type HunterConfig } from "./registry.js";
import { watched, opportunities, discoveryActions, aiExitRequests, prices, db } from "./db.js";
import { screenOpportunity, fetchBuyRequests, type DiscoveryScreen } from "./discovery.js";
import { candlesForToken } from "./candles.js";
import { snapshot, liquidityDropIsSuspicious } from "./indicators.js";
import { assess, assessExit, type TokenProfile, type AiVerdict, type OpenPositionContext } from "./ai.js";
import { executeSwap } from "./executor.js";
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

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

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

async function dispatch(
  id: number, token: string, ai: AiVerdict | null, s: DiscoveryScreen, atrPct: number | null, candidates: VaultRecord[],
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

    if (H.requireAiApproval) {
      if (!ai) {
        log("info", "hunter", `${v.address} ${token}: AI approval required but unavailable, notifying instead of buying`);
        discoveryActions.record(v.address, id, "notified");
        return;
      }
      if (!ai.recommend || CONFIDENCE_RANK[ai.confidence] < CONFIDENCE_RANK[H.minAiConfidence]) {
        log("info", "hunter", `${v.address} ${token}: AI did not clear the bar (recommend=${ai.recommend}, confidence=${ai.confidence}), notifying instead of buying`);
        discoveryActions.record(v.address, id, "notified");
        return;
      }
    }

    await executeHunterBuy(v, id, token, sizeForVault(H, ai), atrPct);
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
  if (s.verdict === "pass" && strictest.anyRequireAi) {
    const profile: TokenProfile = {
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
  await dispatch(id, w.token, ai, s, snap.atrPct, candidates);
}

interface FullModeRow { id: number; vault: string; token: string; opened_at: number; entry_price: number; high_water: number }

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
    `SELECT id, vault, token, opened_at, entry_price, high_water FROM positions WHERE bot='hunter' AND status='open' AND exit_mode='full'`,
  ).all() as FullModeRow[];
  if (rows.length === 0) return;

  const from = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  const symbolByToken = new Map(watched.all().map((w) => [w.token, w.symbol]));

  await mapLimit(rows, CFG.keeperConcurrency, async (r) => {
    try {
      const latest = prices.latest(r.token);
      if (!latest || latest.price <= 0 || r.entry_price <= 0) return;

      const candles = candlesForToken(r.token, from, CANDLE_MINUTES * 60);
      const snap = candles.length ? snapshot(candles) : null;

      const context: OpenPositionContext = {
        symbol: symbolByToken.get(r.token) ?? r.token,
        token: r.token,
        entryPrice: r.entry_price,
        currentPrice: latest.price,
        pnlPct: ((latest.price - r.entry_price) / r.entry_price) * 100,
        peakPnlPct: (r.high_water - 1) * 100, // high_water is a value/cost ratio - 1.0 is breakeven
        minutesHeld: (Math.floor(Date.now() / 1000) - r.opened_at) / 60,
        rsi: snap?.rsi ?? null,
        macdHistogram: snap?.macd?.histogram ?? null,
        macdBullishCross: snap?.macd?.bullishCross ?? null,
        macdBearishCross: snap?.macd?.bearishCross ?? null,
        bollingerPercentB: snap?.bollinger?.percentB ?? null,
        atrPct: snap?.atrPct ?? null,
        volRatio: snap?.volRatio ?? null,
      };

      const verdict = await assessExit(context);
      if (verdict?.sell) {
        aiExitRequests.request(r.id, verdict.reasoning);
        log("info", "hunter", `Position #${r.id} (${context.symbol}): AI exit judgment - ${verdict.reasoning}`);
      }
    } catch (e) {
      log("error", "hunter", `Exit review for position #${r.id}: ${(e as Error).message}`);
    }
  });
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
