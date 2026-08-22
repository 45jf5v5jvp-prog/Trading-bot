import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { registry, type VaultRecord, type HunterConfig } from "./registry.js";
import { watched, opportunities, discoveryActions, aiExitRequests, hunterLessons, prices, db } from "./db.js";
import { screenOpportunity, fetchBuyRequests, type DiscoveryScreen } from "./discovery.js";
import { executeSwap, executeSwapMultiVenue } from "./executor.js";
import { candlesForToken } from "./candles.js";
import { snapshot, liquidityDropIsSuspicious } from "./indicators.js";
import { assess, assessExit, reflectOnLoss, reflectOnMiss, type TokenProfile, type AiVerdict, type OpenPositionContext } from "./ai.js";
import { openPosition, positionsValuePls } from "./positions.js";
import { exceedsHoldingCap } from "./portfolio.js";
import { vaultWethBalance } from "./launch.js";
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
 *
 * Scope: V2-only detection, multi-venue execution - the identical tradeoff
 * discovery.ts already made on this repo, for the identical reason (see its
 * module comment). This keeper's price-history/candle collection
 * (prices.ts's ensureWatched/readPair/pollAll) only ever samples V2 pair
 * reserves, so every token Hunter Bot evaluates (watched.all(), prices,
 * candlesForToken) is V2-quoted by construction - detection needs no
 * venue-awareness. The BUY side (executeHunterBuy) is still vault-kind
 * aware, mirroring discovery.ts's executeDiscoveryBuy exactly: a
 * multiVenue/multiVenueV4 vault has no plain executeSwap entry point at
 * all, even for an ordinary V2 trade, so it always goes through
 * executeSwapMultiVenue with a "v2" venue.
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

function actionsToday(vault: string): number {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const r = db.prepare(`SELECT COUNT(*) n FROM discovery_actions WHERE vault=? AND ts>=?`)
    .get(vault.toLowerCase(), since) as { n: number };
  return r.n;
}

/** How much of its own dedicated allocation this bot currently has
 * deployed, across every vault's open hunter positions. Freed back as
 * positions close (a realized loss shrinks the vault, but frees the same
 * ETH the position was opened with back to the allocation) - allocatedPls
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

function buildNarrative(symbol: string, triggers: string[], s: DiscoveryScreen, ai: AiVerdict | null): string {
  const conf = technicalConfidence(triggers.length);
  const confidenceNote = conf === "high"
    ? ` ${triggers.length} technical signals agree - high confidence.`
    : " One technical signal.";
  const base = `${symbol} looks oversold: ${triggers.join("; ")}.${confidenceNote}`;
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
 *
 * Vault-kind aware, same branching discovery.ts's executeDiscoveryBuy uses
 * for its buy: a multiVenue/multiVenueV4 vault (v.kind !== "v2") has no
 * plain executeSwap entry point at all, even for an ordinary V2 trade - it
 * only exposes executeSwapMultiVenue. Every opportunity here is V2-quoted
 * by construction (see the module comment), so the multi-venue path always
 * uses a "v2" venue.
 */
async function executeHunterBuy(v: VaultRecord, id: number, token: string, amountPls: number): Promise<void> {
  const H = v.hunter;
  if (amountPls <= 0 || H.allocatedPls <= 0) return;

  const deployed = deployedPls(v.address);
  if (deployed + amountPls > H.allocatedPls) {
    log("info", "hunter", `${v.address} ${token}: ${amountPls} ETH would exceed its ${H.allocatedPls} ETH allocation (${deployed} already deployed), skipping`);
    return;
  }

  // The general vault-wide holding cap still applies too, in addition to
  // this bot's own budget - defense in depth, same as every other bot here.
  const { total: posValue, byToken } = await positionsValuePls(v.address);
  const totalValue = (await vaultWethBalance(v.address)) + posValue;
  const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
  if (exceedsHoldingCap(tokenNow + amountPls, totalValue, v.maxHoldingPct)) {
    log("info", "hunter", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping buy`);
    return;
  }

  const amountIn = parseEther(String(amountPls));
  const slippageBps = Math.min(CFG.maxSlippageBps, 300);

  const res = v.kind === "v2"
    ? await executeSwap({ vault: v.address, bot: "hunter", path: [CFG.weth, token], amountIn, tokenLabel: token, slippageBps })
    : await executeSwapMultiVenue({
        vault: v.address, bot: "hunter",
        venue: { kind: "v2", path: [CFG.weth, token] },
        amountIn, tokenLabel: token, slippageBps,
      });

  if (res.ok) {
    // Auto Full: the AI takes over deciding when to exit (see
    // reviewFullModePositions), so the fixed take-profit/trailing/time
    // targets don't apply - only the mandatory stop-loss does, and it's
    // never actually disabled even if stopLossPct was left at 0.
    const slPct = H.exitMode === "full" ? (H.stopLossPct > 0 ? H.stopLossPct : MANDATORY_MIN_STOP_LOSS_PCT) : H.stopLossPct;
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
    log("info", "hunter", `${v.address} bought ${amountPls} ETH of ${token} on opportunity #${id}`);
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
  id: number, token: string, ai: AiVerdict | null, s: DiscoveryScreen, candidates: VaultRecord[],
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

    await executeHunterBuy(v, id, token, sizeForVault(H, vAi));
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
      narrative: `Technical setup: ${triggers.join("; ")}`,
    };
    ai = await assess(profile, strictest.aiCeilingPls > 0 ? strictest.aiCeilingPls : undefined);
  }

  const narrative = buildNarrative(w.symbol, triggers, s, ai);
  const id = opportunities.insert({
    token: w.token, priceMovePct: ((last.close - first.close) / first.close) * 100,
    liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100, liqPls: last.liq,
    buyTaxBps: s.buyTaxBps, sellTaxBps: s.sellTaxBps, lpLockedPct: s.lpLockedPct,
    ownerRenounced: s.ownerRenounced, sellable: s.sellable, verdict: s.verdict, reason: s.reason, narrative,
    source: "hunter", rsi: snap.rsi, macdHistogram: snap.macd?.histogram ?? null, bollingerPercentB: snap.bollinger?.percentB ?? null,
    aiRecommend: ai?.recommend ?? null, aiConfidence: ai?.confidence ?? null, aiReasoning: ai?.reasoning ?? null,
    aiSuggestedAmountPls: ai?.suggestedAmountPls ?? null,
    signalCount: triggers.length,
  });
  log("info", "hunter", `Opportunity #${id}: ${narrative}`);

  if (s.verdict !== "pass") return;
  await dispatch(id, w.token, ai, s, candidates, profile);
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

      // prices.latest() is a raw V2 mid-price (this keeper's price history
      // is V2-only by construction, see this file's module comment) - it
      // has no idea this token might take a cut on transfer, so it always
      // overstates what a real sale would return. Discounted by the same
      // measured sell_tax_bps positions.ts's markToMarket uses, so the AI
      // isn't judging an exit against a price nobody could actually
      // realize - exactly the mismatch that let it believe a position was
      // up when closing it actually locked in a loss.
      const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
        .get(r.token.toLowerCase()) as { sell_tax_bps: number } | undefined;
      const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
      const realizablePrice = latest.price * (1 - taxBps / 10_000);

      const candles = candlesForToken(r.token, from, CANDLE_MINUTES * 60);
      const snap = candles.length ? snapshot(candles) : null;

      const context: OpenPositionContext = {
        symbol: symbolByToken.get(r.token) ?? r.token,
        token: r.token,
        entryPrice: r.entry_price,
        currentPrice: realizablePrice,
        pnlPct: ((realizablePrice - r.entry_price) / r.entry_price) * 100,
        peakPnlPct: (r.high_water - 1) * 100, // high_water is a value/cost ratio - 1.0 is breakeven
        minutesHeld: (Math.floor(Date.now() / 1000) - r.opened_at) / 60,
        rsi: snap?.rsi ?? null,
        macdHistogram: snap?.macd?.histogram ?? null,
        macdBullishCross: snap?.macd?.bullishCross ?? null,
        macdBearishCross: snap?.macd?.bearishCross ?? null,
        bollingerPercentB: snap?.bollinger?.percentB ?? null,
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
 *
 * NOTE (Robinhood port): this repo's own opportunities.insert() call in
 * evaluateWatchedToken above does not currently populate priceAtDetection,
 * so this function has no rows to work with yet - ported as-is, matching
 * the PulseChain keeper's own current behavior, rather than silently
 * changed. Wiring `priceAtDetection: last.close` into that insert() call is
 * a small, self-contained follow-up once that's confirmed intentional (or
 * not) on the PulseChain side.
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
    const ids = await fetchBuyRequests(v.address);
    for (const id of ids) {
      if (discoveryActions.actionFor(v.address, id) === "bought") continue;
      const opp = opportunities.get(id);
      if (!opp || opp.verdict !== "pass" || opp.source !== "hunter") continue;
      try {
        // A manual "Buy Now" from notify mode has no fresh AI verdict of its
        // own - reuse whatever the detector already computed (the AI's
        // sizing shown in the Opportunities panel), clamped to this vault's
        // own ceiling same as an autoBuy would be. Falls back to the full
        // ceiling if no AI ran (requireAiApproval was off at detection time).
        const amountPls = opp.aiSuggestedAmountPls
          ? Math.min(opp.aiSuggestedAmountPls, v.hunter.maxPerTradePls)
          : v.hunter.maxPerTradePls;
        await executeHunterBuy(v, id, opp.token, amountPls);
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

  const candidates = registry.active().filter((v) => v.hunter.enabled);
  if (candidates.length === 0) return;

  // Same "screen once with the loosest bar any subscriber uses" shape
  // discovery.ts and launch.ts use for their own per-token checks.
  const rsiSubs = candidates.filter((c) => c.hunter.requireRsi);
  const bollSubs = candidates.filter((c) => c.hunter.requireBollinger);
  const aiSubs = candidates.filter((c) => c.hunter.requireAiApproval);
  const strictest: Strictest = {
    requireRsi: rsiSubs.length > 0,
    rsiOversold: rsiSubs.length ? Math.max(...rsiSubs.map((c) => c.hunter.rsiOversold)) : 0,
    requireMacdCross: candidates.some((c) => c.hunter.requireMacdCross),
    requireBollinger: bollSubs.length > 0,
    bollingerPercentBMax: bollSubs.length ? Math.max(...bollSubs.map((c) => c.hunter.bollingerPercentBMax)) : 0,
    minLiquidityPls: Math.min(...candidates.map((c) => c.hunter.minLiquidityPls)),
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.hunter.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.hunter.maxSellTaxBps)),
    requireLpLock: candidates.every((c) => c.hunter.requireLpLock),
    requireOwnerRenounced: candidates.every((c) => c.hunter.requireOwnerRenounced),
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
