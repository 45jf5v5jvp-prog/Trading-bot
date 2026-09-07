import { parseEther, Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type VaultRecord, type HunterConfig } from "./registry.js";
import { watched, opportunities, discoveryActions, pendingRebuys, prices, tokenTraders, db } from "./db.js";
import { screenOpportunity, fetchBuyRequests, type DiscoveryScreen } from "./discovery.js";
import { candlesForToken } from "./candles.js";
import { snapshot, liquidityDropIsSuspicious, looksLikeStablecoin, orderFlow, liquidityTrend, donchianBreakout } from "./indicators.js";
import { plsUsd } from "./plsPrice.js";
import { executeSwap } from "./executor.js";
import { openPosition, positionsValuePls } from "./positions.js";
import { exceedsHoldingCap } from "./portfolio.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Hunter Bot: hunts real order-flow/liquidity-flow setups across every
 * watched token, trading a dedicated slice of the vault the owner chose to
 * risk on it - see registry.ts's HunterConfig for the full reasoning.
 *
 * Used to detect off RSI/MACD/Bollinger alone - all three are derived from
 * the same price series, so "2 of 3 agree" was mostly the same fact
 * restated three ways, not real diversification. They're also all
 * mean-reversion reads (bet on a bounce), which assumes a mature, liquid
 * market this bot doesn't actually trade in - on a thin, often-manipulated
 * PulseChain microcap, a big drop is more often the start of a rug or a
 * slow bleed than a statistical bounce waiting to happen. Replaced with four
 * genuinely different reads: buy/sell trade-pressure ratio and new-buyer
 * growth (real on-chain order flow, not price), liquidity trend (real
 * capital committing, not price), and a breakout above the token's own
 * recent high (confirmed strength, not a guessed bottom). See
 * indicators.ts's orderFlow/liquidityTrend/donchianBreakout.
 *
 * Shares its findings feed with discovery.ts (the `opportunities` table,
 * tagged source='hunter') so the site's Opportunities panel and manual
 * "Buy Now" flow work identically for both bots without duplicating that
 * plumbing - see discovery.ts's screenOpportunity/fetchBuyRequests, both
 * exported for exactly this reuse.
 */

const CANDLE_MINUTES = 15;
// Shorter than the old 48h RSI/MACD warm-up window needed - none of the new
// signals need anywhere near that much history (the longest lookback below
// is the 2h breakout channel), and a shorter window means a freshly-watched
// token becomes eligible to trade sooner, plus a more RECENT liquidity-pull
// comparison in liquidityDropIsSuspicious below rather than one diluted
// across two days.
const LOOKBACK_HOURS = 12;
// Shorter than the old 4h - a fresh breakout-with-real-order-flow an hour
// later is a genuinely new confirmation, not "the same setup still going."
// Shorter dedup also means more distinct opportunities can surface across
// the watched-token universe over a given stretch, which is the point: the
// owner wants Hunter finding and closing several trades, not one setup
// slow-cooking for hours before it's allowed to fire again.
const DEDUP_HOURS = 1;
// Matches volumeConfirmation's own floor (needs recentCount*2 = 16 candles
// to compare a recent window against a baseline) - the binding constraint
// now, since none of the order-flow/liquidity/breakout signals below need
// nearly this much history on their own.
const MIN_CANDLES = 16;
// Bounds on an ATR-derived stop distance, regardless of atrStopMultiplier -
// a stop tighter than this on a low-cap PulseX token is almost certainly
// noise-triggered, not a real invalidation of the setup; a stop looser than
// this is not meaningfully a stop at all.
const ATR_STOP_MIN_PCT = 5;
const ATR_STOP_MAX_PCT = 80;

// Trailing window for buy/sell trade-pressure ratio - 4 candles * 15min.
const ORDER_FLOW_LOOKBACK_CANDLES = 4;
// Floor on total trades in that window before trusting the ratio it
// produces - one lucky trade reading 100% buys isn't a signal, it's noise
// from a nearly-empty sample.
const MIN_ORDER_FLOW_TRADES = 3;
// Compares liquidity now against liquidity this many candles back - same
// 60-minute window as order flow, for the same "is something real
// happening right now" framing.
const LIQUIDITY_TREND_LOOKBACK_CANDLES = 4;
// How far back "distinct new buyers" looks - see db.ts's tokenTraders.
const BUYER_WINDOW_MIN = 60;
// Donchian channel width for the breakout confirmation - 8 candles * 15min.
const BREAKOUT_LOOKBACK_CANDLES = 8;

interface Strictest {
  requireBuyPressure: boolean; minBuyPressureRatio: number;
  requireLiquidityGrowth: boolean; minLiquidityGrowthPct: number;
  requireBuyerGrowth: boolean; minNewBuyers: number;
  requireBreakout: boolean;
  requireVolumeConfirmation: boolean; minVolumeRatio: number;
  minLiquidityPls: number;
  minTrades24h: number;
  minUniqueTraders24h: number;
  maxBuyTaxBps: number; maxSellTaxBps: number;
  requireLpLock: boolean; requireOwnerRenounced: boolean;
}

/** The stop-loss % to actually bake into a position at open time. ATR-based
 * when the vault opted in and a real ATR reading was available at detection
 * time, clamped to a sane range either way; otherwise the flat configured
 * stopLossPct. */
function computeStopLossPct(H: HunterConfig, atrPct: number | null): number {
  let pct = H.stopLossPct;
  if (H.useAtrStop && atrPct !== null && atrPct > 0) {
    pct = Math.min(ATR_STOP_MAX_PCT, Math.max(ATR_STOP_MIN_PCT, atrPct * H.atrStopMultiplier));
  }
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
 * deployed, across this vault's open hunter positions. Freed back as
 * positions close (a realized loss shrinks the vault, but frees the same
 * PLS the position was opened with back to the allocation) - allocatedPls
 * caps concurrent exposure, not lifetime spend. This is the default mode;
 * see spentPlsLast24h below for the alternative "resets daily" mode. */
function deployedPls(vault: string): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(spent_pls),0) s FROM positions WHERE vault=? AND bot='hunter' AND status='open'`,
  ).get(vault.toLowerCase()) as { s: number };
  return r.s;
}

/** Alternative to deployedPls for allocatedResetDaily: how much this vault's
 * Hunter Bot has actually SPENT on buys in the last 24 hours, open or
 * already closed - a rolling activity-pace limit rather than a concurrent-
 * exposure one. Unlike deployedPls, an old position sitting open a long
 * time doesn't keep tying up the budget forever; it just ages out of the
 * 24h window and frees fresh room to buy, same "resets daily" spirit as
 * actionsToday above (same rolling-window shape, deliberately - not a
 * calendar-day reset, so nothing clusters right at a UTC boundary). */
function spentPlsLast24h(vault: string): number {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const r = db.prepare(
    `SELECT COALESCE(SUM(spent_pls),0) s FROM positions WHERE vault=? AND bot='hunter' AND opened_at>=?`,
  ).get(vault.toLowerCase(), since) as { s: number };
  return r.s;
}

/** How many Hunter positions this vault currently has open - the count a
 * maxOpenPositions setting caps, independent of the PLS-based allocation/
 * holding-cap checks above (a vault could have room left in its budget but
 * still be capped on number of simultaneous bets, e.g. someone who wants
 * five smaller positions rather than fewer bigger ones). 0 disables. */
function openPositionCount(vault: string): number {
  const r = db.prepare(
    `SELECT COUNT(*) n FROM positions WHERE vault=? AND bot='hunter' AND status='open'`,
  ).get(vault.toLowerCase()) as { n: number };
  return r.n;
}

// Both Strictest (the shared, loosest-across-subscribers detection config)
// and HunterConfig (a single vault's real settings) carry these same eight
// fields, so checkSignals can be called once with strictest for detection
// and again per-vault with each vault's own H for buy-time re-verification -
// see dispatch() below.
interface TriggerConfig {
  requireBuyPressure: boolean; minBuyPressureRatio: number;
  requireLiquidityGrowth: boolean; minLiquidityGrowthPct: number;
  requireBuyerGrowth: boolean; minNewBuyers: number;
  requireBreakout: boolean;
}

interface SignalReadout {
  buyRatio: number | null;
  orderFlowTrades: number;
  liqTrendPct: number | null;
  newBuyers: number;
  brokeOut: boolean;
  pctAboveHigh: number | null;
}

/**
 * Every ENABLED requirement must pass - unlike the old RSI/MACD/Bollinger
 * "2 of 3 agree" voting (needed because all three were derived from the
 * same price series, so agreement between them was mostly the same fact
 * restated, not real independent confirmation), these four signals measure
 * genuinely different things: order flow, capital flow, participation, and
 * price structure. Requiring all of them isn't the same collinear-noise
 * problem - it's just several independent necessary conditions, the same
 * shape every other screen in this codebase already uses (tax caps, LP
 * lock, liquidity floor - always ANDed, never voted on). Returns the
 * reasons that DID fire, for the narrative; null means some enabled
 * requirement failed.
 */
function checkSignals(r: SignalReadout, cfg: TriggerConfig): string[] | null {
  const hits: string[] = [];
  if (cfg.requireBuyPressure) {
    if (r.buyRatio === null || r.orderFlowTrades < MIN_ORDER_FLOW_TRADES || r.buyRatio < cfg.minBuyPressureRatio) return null;
    hits.push(`${(r.buyRatio * 100).toFixed(0)}% of the last ${r.orderFlowTrades} trades were buys`);
  }
  if (cfg.requireLiquidityGrowth) {
    if (r.liqTrendPct === null || r.liqTrendPct < cfg.minLiquidityGrowthPct) return null;
    hits.push(`liquidity ${r.liqTrendPct >= 0 ? "up" : "down"} ${r.liqTrendPct.toFixed(1)}% over the last hour`);
  }
  if (cfg.requireBuyerGrowth) {
    if (r.newBuyers < cfg.minNewBuyers) return null;
    hits.push(`${r.newBuyers} distinct new buyers in the last hour`);
  }
  if (cfg.requireBreakout) {
    if (!r.brokeOut) return null;
    hits.push(`price broke out to a new local high${r.pctAboveHigh !== null ? ` (+${r.pctAboveHigh.toFixed(1)}%)` : ""}`);
  }
  return hits;
}

function buildNarrative(symbol: string, hits: string[], s: DiscoveryScreen, volRatio: number | null): string {
  const volNote = volRatio !== null && Number.isFinite(volRatio)
    ? ` Recent volume is running ${volRatio.toFixed(1)}x its baseline.`
    : "";
  const base = hits.length
    ? `${symbol} shows real strength: ${hits.join("; ")}.${volNote}`
    : `${symbol} passed every enabled requirement (none configured require confirming data).${volNote}`;
  if (s.verdict !== "pass") return `${base} Screen failed: ${s.reason}.`;
  return `${base} Passed the same honeypot, tax, LP-lock and renounce screen the Launch Bot runs.`;
}

/** `amountPls` is always this vault's own configured ceiling (H.maxPerTradePls) -
 * the caller doesn't decide anything clever here, it's just threaded through
 * so callers with their own amount (a site-submitted buy request, an
 * auto-rebuy) can still clamp to it. */
async function executeHunterBuy(v: VaultRecord, id: number, token: string, amountPls: number, atrPct: number | null): Promise<void> {
  const H = v.hunter;
  if (amountPls <= 0 || (!H.allocatedUnlimited && H.allocatedPls <= 0)) return;

  if (!H.allocatedUnlimited) {
    const deployed = H.allocatedResetDaily ? spentPlsLast24h(v.address) : deployedPls(v.address);
    if (deployed + amountPls > H.allocatedPls) {
      const kind = H.allocatedResetDaily ? "24h spending" : "PLS allocation";
      log("info", "hunter", `${v.address} ${token}: ${amountPls} PLS would exceed its ${H.allocatedPls} ${kind} (${deployed} already used), skipping`);
      return;
    }
  }

  if (H.maxOpenPositions > 0 && openPositionCount(v.address) >= H.maxOpenPositions) {
    log("info", "hunter", `${v.address} ${token}: already at its ${H.maxOpenPositions}-position cap, skipping`);
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
    const slPct = computeStopLossPct(H, atrPct);
    openPosition({
      vault: v.address, bot: "hunter", token,
      spentPls: amountPls, tokensOut: res.amountOut,
      tpPct: H.takeProfitPct,
      slPct,
      trailPct: H.trailingStopPct,
      tightTrailPct: H.tightTrailPct,
      trailWidenAtPct: H.trailWidenAtPct,
      timeExitMin: H.timeExitMin,
      sourceTxHash: res.txHash,
    });
    discoveryActions.record(v.address, id, "bought", res.txHash);
    log("info", "hunter", `${v.address} bought ${amountPls} PLS of ${token} on opportunity #${id}`);
  } else {
    log("warn", "hunter", `${v.address} skipped opportunity #${id} (${token}): ${res.reason}`);
  }
}

async function dispatch(
  id: number, token: string, s: DiscoveryScreen, atrPct: number | null, volRatio: number | null,
  candidates: VaultRecord[], liqPls: number, trades24hEquivalent: number, uniqueTraders24h: number,
  readout: SignalReadout,
): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const H = v.hunter;
    if (s.buyTaxBps > H.maxBuyTaxBps) return;
    if (s.sellTaxBps > H.maxSellTaxBps) return;
    if (H.requireLpLock && s.lpLockedPct < 80) return;
    if (H.requireOwnerRenounced && !s.ownerRenounced) return;
    // The shared detection stage above screens using the LOOSEST liquidity/
    // trade-count floor across every subscribed vault (see strictest's own
    // comment) - real per-vault enforcement has to happen here, same as
    // requireLpLock/requireOwnerRenounced just above. Missing this meant a
    // vault with a strict minLiquidityPls could still get bought into for a
    // token that only cleared some OTHER, looser vault's floor - confirmed
    // live 2026-08-23: a 20,000,000 PLS floor still bought a 7,000,000 PLS
    // liquidity token.
    if (liqPls < H.minLiquidityPls) return;
    if (trades24hEquivalent < H.minTrades24h) return;
    // Same re-verification, for the same reason - see registry.ts's
    // minUniqueTraders24h comment for what this actually catches that
    // trades24hEquivalent alone can't (one wallet trading with itself).
    if (uniqueTraders24h < H.minUniqueTraders24h) return;
    // Same bug, same fix, for the order-flow/liquidity-trend/buyer-growth/
    // breakout requirements: the shared detection stage above only ever
    // checked the loosest-across-subscribers strictest values, never each
    // vault's own thresholds, so a vault with a strict requirement (or one
    // requiring a signal a looser subscriber didn't) could get bought into
    // on a signal that only cleared some OTHER vault's bar. Re-derive this
    // vault's own signals from the same real readout and require them to
    // clear this vault's own thresholds before buying.
    if (checkSignals(readout, H) === null) return;
    if (H.requireVolumeConfirmation && (volRatio === null || volRatio < H.minVolumeRatio)) return;
    if (discoveryActions.has(v.address, id)) return;
    if (actionsToday(v.address) >= H.maxPerDay) return;

    if (H.mode === "notify") {
      discoveryActions.record(v.address, id, "notified");
      log("info", "hunter", `${v.address} notified of opportunity #${id} (${token})`);
      return;
    }

    await executeHunterBuy(v, id, token, H.maxPerTradePls, atrPct);
  });
}

async function evaluateWatchedToken(
  w: { token: string; symbol: string; pair: string },
  strictest: Strictest, from: number, dedupSince: number, candidates: VaultRecord[],
): Promise<void> {
  if (opportunities.recentForToken(w.token, dedupSince)) return;

  const candles = candlesForToken(w.token, from, CANDLE_MINUTES * 60);
  if (candles.length < MIN_CANDLES) return;

  // Hard gate, not configurable - see indicators.ts's looksLikeStablecoin
  // for the full reasoning. Checked before any of the real signal math
  // below, since a USD-pegged token's price/liquidity readings aren't
  // measuring anything real about the token at all.
  const usdPerPls = await plsUsd().catch(() => null);
  if (usdPerPls !== null && looksLikeStablecoin(candles.map((c) => c.close), usdPerPls)) return;

  // Still uses snapshot() for its atrPct (stop-loss sizing) and volRatio
  // (the volume-confirmation gate below) - its rsi/macd/bollinger fields
  // are simply not read anymore.
  const snap = snapshot(candles);
  if (!snap) return;

  const of = orderFlow(candles, ORDER_FLOW_LOOKBACK_CANDLES);
  const liqTrendPct = liquidityTrend(candles, LIQUIDITY_TREND_LOOKBACK_CANDLES);
  const dayAgoForBuyers = Math.floor(Date.now() / 1000) - BUYER_WINDOW_MIN * 60;
  const newBuyers = tokenTraders.count(w.token, dayAgoForBuyers, "buy");
  const breakout = donchianBreakout(candles, BREAKOUT_LOOKBACK_CANDLES);
  const readout: SignalReadout = {
    buyRatio: of?.buyRatio ?? null, orderFlowTrades: of?.totalTrades ?? 0,
    liqTrendPct, newBuyers,
    brokeOut: breakout?.brokeOut ?? false, pctAboveHigh: breakout?.pctAboveHigh ?? null,
  };

  const hits = checkSignals(readout, strictest);
  // Any enabled requirement failing means this isn't a setup worth
  // screening at all, let alone buying.
  if (hits === null) return;

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  if (last.liq < strictest.minLiquidityPls) return;

  // Confirmation gate, not an alternative trigger: real trading volume
  // behind the move, on top of the order-flow/liquidity/breakout signals
  // above. Skipped entirely (not recorded) rather than shown as a rejected
  // opportunity - unlike the liquidity-pull check below, "not enough volume
  // yet" isn't itself an interesting finding, it just means try again later.
  if (strictest.requireVolumeConfirmation && (snap.volRatio === null || snap.volRatio < strictest.minVolumeRatio)) return;

  // Liveness gate: is this token actually being traded, at all, right now -
  // as opposed to sitting still with one stale trade from days ago. A token
  // this young can't have a full 24h of coverage yet, so this extrapolates
  // from whatever's actually available in the last day rather than
  // requiring a complete window - MIN_CANDLES above already guarantees at
  // least 4 hours of real data by this point. Computed regardless of
  // whether the shared strictest.minTrades24h is 0 - dispatch() below needs
  // the real number to re-check each vault's own floor individually, not
  // just the shared loosest one.
  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 3600;
  const recentCandles = candles.filter((c) => c.ts >= dayAgo);
  const tradesRecent = recentCandles.reduce((sum, c) => sum + c.trades, 0);
  const hoursAvailable = recentCandles.length ? Math.max(1, (Math.floor(Date.now() / 1000) - recentCandles[0]!.ts) / 3600) : 0;
  const trades24hEquivalent = hoursAvailable > 0 ? (tradesRecent / hoursAvailable) * 24 : 0;
  if (strictest.minTrades24h > 0 && trades24hEquivalent < strictest.minTrades24h) return;

  // Distinct-wallet check - see db.ts's tokenTraders/registry.ts's
  // minUniqueTraders24h comments for why this exists alongside trade count
  // rather than instead of it. Computed regardless of whether the shared
  // strictest.minUniqueTraders24h is 0, same reasoning as trades24hEquivalent
  // just above - dispatch() needs the real number for each vault's own floor.
  const uniqueTraders24h = tokenTraders.count(w.token, dayAgo);
  if (strictest.minUniqueTraders24h > 0 && uniqueTraders24h < strictest.minUniqueTraders24h) return;

  // Hard gate, not configurable - the exact trap this bot exists to avoid.
  // Recorded and shown rather than silently dropped, same as a failed
  // screen: seeing "this looked strong but liquidity looks pulled" is
  // itself useful, not noise.
  if (liquidityDropIsSuspicious(first.close, last.close, first.liq, last.liq)) {
    const id = opportunities.insert({
      token: w.token, priceMovePct: ((last.close - first.close) / first.close) * 100,
      liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100, liqPls: last.liq,
      buyTaxBps: null, sellTaxBps: null, lpLockedPct: null, ownerRenounced: null, sellable: false,
      verdict: "fail", reason: "liquidity fell far more than the price move explains - looks like LP was pulled, not organic selling",
      narrative: `${w.symbol} showed real strength (${hits.join("; ") || "passed every enabled requirement"}) but its liquidity dropped more than the price move alone would explain - this looks like a liquidity pull, not real momentum. Skipped.`,
      source: "hunter", signalCount: hits.length,
      buyRatio: readout.buyRatio, liqTrendPct: readout.liqTrendPct, newBuyers: readout.newBuyers, brokeOut: readout.brokeOut,
    });
    log("warn", "hunter", `Opportunity #${id}: ${w.symbol} rejected - liquidity pull signature, not real momentum`);
    return;
  }

  const s = await screenOpportunity(w.token, w.pair, strictest);

  const narrative = buildNarrative(w.symbol, hits, s, snap.volRatio);
  const id = opportunities.insert({
    token: w.token, priceMovePct: ((last.close - first.close) / first.close) * 100,
    liqGrowthPct: ((last.liq - first.liq) / first.liq) * 100, liqPls: last.liq,
    buyTaxBps: s.buyTaxBps, sellTaxBps: s.sellTaxBps, lpLockedPct: s.lpLockedPct,
    ownerRenounced: s.ownerRenounced, sellable: s.sellable, verdict: s.verdict, reason: s.reason, narrative,
    source: "hunter",
    atrPct: snap.atrPct, volRatio: snap.volRatio, signalCount: hits.length,
    buyRatio: readout.buyRatio, liqTrendPct: readout.liqTrendPct, newBuyers: readout.newBuyers, brokeOut: readout.brokeOut,
  });
  log("info", "hunter", `Opportunity #${id}: ${narrative}`);

  if (s.verdict !== "pass") return;
  await dispatch(id, w.token, s, snap.atrPct, snap.volRatio, candidates, last.liq, trades24hEquivalent, uniqueTraders24h, readout);
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
    const qualifies = reason.startsWith("take profit") || reason.startsWith("trailing stop");
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
 * through the normal order-flow/liquidity/breakout detection pass.
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
    if (amountPls <= 0 || (!H.allocatedUnlimited && H.allocatedPls <= 0)) { pendingRebuys.remove(p.id); return; }

    if (!H.allocatedUnlimited) {
      const deployed = H.allocatedResetDaily ? spentPlsLast24h(v.address) : deployedPls(v.address);
      if (deployed + amountPls > H.allocatedPls) return; // try again next tick - allocation may free up
    }

    if (H.maxOpenPositions > 0 && openPositionCount(v.address) >= H.maxOpenPositions) return; // try again next tick - a slot may free up

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
        tpPct: H.takeProfitPct,
        slPct,
        trailPct: H.trailingStopPct,
        tightTrailPct: H.tightTrailPct,
        trailWidenAtPct: H.trailWidenAtPct,
        timeExitMin: H.timeExitMin,
        sourceTxHash: res.txHash,
      });
      pendingRebuys.remove(p.id);
      log("info", "hunter", `${p.vault}: auto-rebuy filled for ${p.token} at ${amountPls} PLS, tx=${res.txHash}`);
    } catch (e) {
      log("error", "hunter", `Auto-rebuy execution for ${p.token} on ${p.vault}: ${(e as Error).message}`);
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
        // gets. Without one, fall back to the full ceiling.
        const amountPls = requestedAmountPls
          ? Math.min(requestedAmountPls, v.hunter.maxPerTradePls)
          : v.hunter.maxPerTradePls;
        await executeHunterBuy(v, id, opp.token, amountPls, opp.atrPct ?? null);
      } catch (e) {
        log("error", "hunter", `${v.address} buy request for opportunity #${id}: ${(e as Error).message}`);
      }
    }
  });
}

export async function tick(): Promise<void> {
  // Runs regardless of whether Hunter is enabled anywhere right now - same
  // reasoning as the reflection passes above - an already-queued rebuy (or
  // one from a position that just closed) shouldn't stall just because
  // detection is skipped this tick.
  await considerAutoRebuys();
  await checkPendingRebuys();

  const candidates = registry.active().filter((v) => v.hunter.enabled);
  if (candidates.length === 0) return;

  // Same "screen once with the loosest bar any subscriber uses" shape
  // discovery.ts and launch.ts use for their own per-token checks. All four
  // new requirement fields are ">= threshold" checks, so the loosest shared
  // bar for each is the SMALLEST threshold among subscribers who require it
  // at all (unlike the old rsiOversold/bollingerPercentBMax, which were
  // "<= threshold" checks and needed the loosest bar to be the LARGEST).
  const buyPressureSubs = candidates.filter((c) => c.hunter.requireBuyPressure);
  const liqGrowthSubs = candidates.filter((c) => c.hunter.requireLiquidityGrowth);
  const buyerGrowthSubs = candidates.filter((c) => c.hunter.requireBuyerGrowth);
  const volSubs = candidates.filter((c) => c.hunter.requireVolumeConfirmation);
  const strictest: Strictest = {
    requireBuyPressure: buyPressureSubs.length > 0,
    minBuyPressureRatio: buyPressureSubs.length ? Math.min(...buyPressureSubs.map((c) => c.hunter.minBuyPressureRatio)) : 0,
    requireLiquidityGrowth: liqGrowthSubs.length > 0,
    minLiquidityGrowthPct: liqGrowthSubs.length ? Math.min(...liqGrowthSubs.map((c) => c.hunter.minLiquidityGrowthPct)) : 0,
    requireBuyerGrowth: buyerGrowthSubs.length > 0,
    minNewBuyers: buyerGrowthSubs.length ? Math.min(...buyerGrowthSubs.map((c) => c.hunter.minNewBuyers)) : 0,
    requireBreakout: candidates.some((c) => c.hunter.requireBreakout),
    requireVolumeConfirmation: volSubs.length > 0,
    // Lower = easier to pass, so the loosest shared bar is the SMALLEST
    // minVolumeRatio among subscribers.
    minVolumeRatio: volSubs.length ? Math.min(...volSubs.map((c) => c.hunter.minVolumeRatio)) : 0,
    minLiquidityPls: Math.min(...candidates.map((c) => c.hunter.minLiquidityPls)),
    minTrades24h: Math.min(...candidates.map((c) => c.hunter.minTrades24h)),
    minUniqueTraders24h: Math.min(...candidates.map((c) => c.hunter.minUniqueTraders24h)),
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
