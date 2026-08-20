import { parseEther, Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type VaultRecord, type HunterConfig } from "./registry.js";
import { watched, opportunities, discoveryActions, db } from "./db.js";
import { screenOpportunity, fetchBuyRequests, type DiscoveryScreen } from "./discovery.js";
import { candlesForToken } from "./candles.js";
import { snapshot, liquidityDropIsSuspicious } from "./indicators.js";
import { assess, type TokenProfile, type AiVerdict } from "./ai.js";
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

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

interface Strictest {
  requireRsi: boolean; rsiOversold: number;
  requireMacdCross: boolean;
  requireBollinger: boolean; bollingerPercentBMax: number;
  minLiquidityPls: number;
  maxBuyTaxBps: number; maxSellTaxBps: number;
  requireLpLock: boolean; requireOwnerRenounced: boolean;
  anyRequireAi: boolean;
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

function buildNarrative(symbol: string, triggers: string[], s: DiscoveryScreen, ai: AiVerdict | null): string {
  const base = `${symbol} looks oversold: ${triggers.join("; ")}.`;
  if (s.verdict !== "pass") return `${base} Screen failed: ${s.reason}.`;
  const screened = `${base} Passed the same honeypot, tax, LP-lock and renounce screen the Launch Bot runs.`;
  if (!ai) return screened;
  return `${screened} AI take (${ai.confidence} confidence, ${ai.recommend ? "would buy" : "would not buy"}): ${ai.reasoning}`;
}

async function executeHunterBuy(v: VaultRecord, id: number, token: string): Promise<void> {
  const H = v.hunter;
  if (H.perTradePls <= 0 || H.allocatedPls <= 0) return;

  const deployed = deployedPls(v.address);
  if (deployed + H.perTradePls > H.allocatedPls) {
    log("info", "hunter", `${v.address} ${token}: would exceed its ${H.allocatedPls} PLS allocation (${deployed} already deployed), skipping`);
    return;
  }

  // The general vault-wide holding cap still applies too, in addition to
  // this bot's own budget - defense in depth, same as every other bot here.
  const { total: posValue, byToken } = await positionsValuePls(v.address);
  const totalValue = (await vaultWplsPls(v.address)) + posValue;
  const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
  if (exceedsHoldingCap(tokenNow + H.perTradePls, totalValue, v.maxHoldingPct)) {
    log("info", "hunter", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping buy`);
    return;
  }

  const amountIn = parseEther(String(H.perTradePls));
  const res = await executeSwap({
    vault: v.address, bot: "hunter", path: [CFG.wpls, token], amountIn, tokenLabel: token,
    slippageBps: Math.min(CFG.maxSlippageBps, 300),
  });

  if (res.ok) {
    openPosition({
      vault: v.address, bot: "hunter", token,
      spentPls: H.perTradePls, tokensOut: res.amountOut,
      tpPct: H.takeProfitPct, slPct: H.stopLossPct, trailPct: H.trailingStopPct, timeExitMin: H.timeExitMin,
    });
    discoveryActions.record(v.address, id, "bought", res.txHash);
    log("info", "hunter", `${v.address} bought ${H.perTradePls} PLS of ${token} on opportunity #${id}`);
  } else {
    log("warn", "hunter", `${v.address} skipped opportunity #${id} (${token}): ${res.reason}`);
  }
}

async function dispatch(
  id: number, token: string, ai: AiVerdict | null, s: DiscoveryScreen, candidates: VaultRecord[],
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

    await executeHunterBuy(v, id, token);
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
  if (triggers.length === 0) return;

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
      narrative: `Technical setup: ${triggers.join("; ")}`,
    };
    ai = await assess(profile);
  }

  const narrative = buildNarrative(w.symbol, triggers, s, ai);
  const id = opportunities.insert({
    token: w.token, priceMovePct: ((last.close - first.close) / first.close) * 100,
    liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100, liqPls: last.liq,
    buyTaxBps: s.buyTaxBps, sellTaxBps: s.sellTaxBps, lpLockedPct: s.lpLockedPct,
    ownerRenounced: s.ownerRenounced, sellable: s.sellable, verdict: s.verdict, reason: s.reason, narrative,
    source: "hunter", rsi: snap.rsi, macdHistogram: snap.macd?.histogram ?? null, bollingerPercentB: snap.bollinger?.percentB ?? null,
    aiRecommend: ai?.recommend ?? null, aiConfidence: ai?.confidence ?? null, aiReasoning: ai?.reasoning ?? null,
  });
  log("info", "hunter", `Opportunity #${id}: ${narrative}`);

  if (s.verdict !== "pass") return;
  await dispatch(id, w.token, ai, s, candidates);
}

async function processHunterBuyRequests(candidates: VaultRecord[]): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const ids = await fetchBuyRequests(v.address);
    for (const id of ids) {
      if (discoveryActions.actionFor(v.address, id) === "bought") continue;
      const opp = opportunities.get(id);
      if (!opp || opp.verdict !== "pass" || opp.source !== "hunter") continue;
      try {
        await executeHunterBuy(v, id, opp.token);
      } catch (e) {
        log("error", "hunter", `${v.address} buy request for opportunity #${id}: ${(e as Error).message}`);
      }
    }
  });
}

export async function tick(): Promise<void> {
  const candidates = registry.active().filter((v) => v.hunter.enabled);
  if (candidates.length === 0) return;

  // Same "screen once with the loosest bar any subscriber uses" shape
  // discovery.ts and launch.ts use for their own per-token checks.
  const rsiSubs = candidates.filter((c) => c.hunter.requireRsi);
  const bollSubs = candidates.filter((c) => c.hunter.requireBollinger);
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
    anyRequireAi: candidates.some((c) => c.hunter.requireAiApproval),
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
