import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { registry, type VaultRecord, type DiscoveryConfig } from "./registry.js";
import { watched, prices, opportunities, discoveryActions, db } from "./db.js";
import { simulate, lpLockedPct, checkOwnerRenounced } from "./screener.js";
import { executeSwap } from "./executor.js";
import { openPosition, positionsValuePls, hasStuckHistory } from "./positions.js";
import { exceedsHoldingCap } from "./portfolio.js";
import { vaultWplsPls } from "./launch.js";
import { mapLimit } from "./concurrency.js";
import { looksLikeStablecoin } from "./indicators.js";
import { plsUsd } from "./plsPrice.js";
import { log } from "./log.js";
import { fetchWithTimeout } from "./httpTimeout.js";

/**
 * Discovery Bot: instead of waiting on a fresh launch or a user-chosen
 * address, this watches every token the keeper has ever seen (see prices.ts's
 * ensureWatched, now called unconditionally from launch.ts for every new
 * PulseX pair, not just ones a Launch Bot subscriber is interested in) for a
 * price move and a liquidity increase happening together over a fixed
 * 60-minute window. Liquidity growing alongside price is the cheap, honest
 * signal that real buying is happening rather than a wash-traded pump on thin
 * liquidity.
 *
 * This is arithmetic on price history the keeper already collects, not an
 * AI/LLM call - the narrative field is a plain-English template built from
 * the same numbers, not a model-generated one.
 *
 * "Trending" is not "safe": every candidate still runs the same honeypot/tax/
 * LP-lock/renounce screen a Launch Bot buy gets, using the exact same probe
 * and the exact same rejection reasons, before anything executes or is even
 * shown as buyable. The one Launch Bot check this omits is deployer-share -
 * there's no deployer address on file for a token discovered this way, only
 * for ones seen at pair-creation time.
 */

const DETECT_WINDOW_HOURS = 1;
// How long a token stays "already flagged" before the same kind of anomaly
// can produce a new opportunity row. Shorter than this and a token sitting
// above threshold for hours would spam a fresh row (and a fresh notify/buy
// decision) on every scan pass while nothing has actually changed.
const DEDUP_HOURS = 2;
const MIN_POINTS = 3;

export interface DiscoveryScreen {
  sellable: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  roundTripLossBps: number;
  lpLockedPct: number;
  ownerRenounced: boolean;
  verdict: "pass" | "fail";
  reason: string;
}

/**
 * Same checks screener.ts's screen() runs, minus the liquidity floor (already
 * applied from our own price history before this is called) and minus the
 * deployer-share check (no deployer on file - see the module comment above).
 *
 * Exported so hunter.ts can run the identical screen on its own candidates
 * rather than duplicating it - a technical setup deserves exactly the same
 * scrutiny a price/liquidity anomaly does, no lighter and no heavier.
 */
export async function screenOpportunity(
  token: string,
  pair: string,
  limits: { maxBuyTaxBps: number; maxSellTaxBps: number; requireLpLock: boolean; requireOwnerRenounced: boolean },
): Promise<DiscoveryScreen> {
  const out: DiscoveryScreen = {
    sellable: false, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 0,
    lpLockedPct: 0, ownerRenounced: true, verdict: "fail", reason: "",
  };

  // Checked before spending an RPC round trip on a fresh simulation at all -
  // a token that already got a position stuck (any vault, ever) doesn't get
  // a second chance just because it happens to simulate clean this time. See
  // positions.ts's hasStuckHistory for why a live sim isn't trusted over this.
  if (hasStuckHistory(token)) return { ...out, reason: "previously left a position stuck - this token has already proven unsellable" };

  const sim = await simulate(token);
  if (!sim) return { ...out, reason: "simulation unavailable, refusing to guess" };
  out.sellable = sim.sellable;
  out.buyTaxBps = sim.buyTaxBps;
  out.sellTaxBps = sim.sellTaxBps;
  out.roundTripLossBps = sim.roundTripLossBps;

  if (!sim.sellable) return { ...out, reason: "cannot sell after buying" };
  if (sim.roundTripLossBps > CFG.honeypotMaxLossBps)
    return { ...out, reason: `round trip loses ${sim.roundTripLossBps} bps` };
  if (sim.buyTaxBps > limits.maxBuyTaxBps)
    return { ...out, reason: `buy tax ${(sim.buyTaxBps / 100).toFixed(1)}% over limit` };
  if (sim.sellTaxBps > limits.maxSellTaxBps)
    return { ...out, reason: `sell tax ${(sim.sellTaxBps / 100).toFixed(1)}% over limit` };

  out.lpLockedPct = await lpLockedPct(pair);
  if (limits.requireLpLock && out.lpLockedPct < 80)
    return { ...out, reason: `only ${out.lpLockedPct.toFixed(1)}% of LP is locked or burned` };

  out.ownerRenounced = await checkOwnerRenounced(token);
  if (limits.requireOwnerRenounced && !out.ownerRenounced)
    return { ...out, reason: "owner has not renounced control of the contract" };

  out.verdict = "pass";
  out.reason = "clear";
  return out;
}

function buildNarrative(
  symbol: string, priceMovePct: number, liqGrowthPct: number, liqPls: number, s: DiscoveryScreen,
): string {
  const base = `${symbol} moved ${priceMovePct >= 0 ? "up" : "down"} ${Math.abs(priceMovePct).toFixed(0)}% ` +
    `in the last hour while liquidity grew ${liqGrowthPct.toFixed(0)}% to ${Math.round(liqPls).toLocaleString()} PLS.`;
  if (s.verdict === "pass")
    return `${base} Passed the same honeypot, tax, LP-lock and renounce screen the Launch Bot runs.`;
  return `${base} Screen failed: ${s.reason}.`;
}

function actionsToday(vault: string): number {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const r = db.prepare(`SELECT COUNT(*) n FROM discovery_actions WHERE vault=? AND ts>=?`)
    .get(vault.toLowerCase(), since) as { n: number };
  return r.n;
}

/**
 * The actual buy, shared by autoBuy-mode dispatch and by a manual "Buy Now"
 * request from notify mode (see fetchBuyRequests below). Sized off the
 * vault's own configured discovery.amountPls by default; `amountOverride`
 * lets a manual "Buy Now" request spend whatever the owner typed in instead
 * (see site/pages/api/vaults/[address]/opportunities/[id]/buy.js) - still
 * subject to the same holding-cap guard either way.
 */
async function executeDiscoveryBuy(v: VaultRecord, id: number, token: string, amountOverride?: number): Promise<void> {
  const D = v.discovery;
  const amountPls = amountOverride ?? D.amountPls;
  if (amountPls <= 0) return;

  // Same holding-cap guard the Launch Bot uses. A token discovered this way
  // has no position yet, so its current value is whatever's already open.
  const { total: posValue, byToken } = await positionsValuePls(v.address);
  const totalValue = (await vaultWplsPls(v.address)) + posValue;
  const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
  if (exceedsHoldingCap(tokenNow + amountPls, totalValue, v.maxHoldingPct)) {
    log("info", "discovery", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping buy`);
    return;
  }

  const amountIn = parseEther(String(amountPls));
  const res = await executeSwap({
    vault: v.address, bot: "discovery", path: [CFG.wpls, token], amountIn, tokenLabel: token,
    // New attention on a token can move price fast, same reasoning as launch/snipe.
    slippageBps: Math.min(CFG.maxSlippageBps, 300),
  });

  if (res.ok) {
    openPosition({
      vault: v.address, bot: "discovery", token,
      spentPls: amountPls, tokensOut: res.amountOut,
      tpPct: D.takeProfitPct, slPct: D.stopLossPct, trailPct: D.trailingStopPct, timeExitMin: D.timeExitMin,
    });
    discoveryActions.record(v.address, id, "bought", res.txHash);
    log("info", "discovery", `${v.address} bought ${amountPls} PLS of ${token} on opportunity #${id}`);
  } else {
    log("warn", "discovery", `${v.address} skipped opportunity #${id} (${token}): ${res.reason}`);
  }
}

/**
 * Notify-mode and autoBuy-mode candidates alike run through here, one
 * opportunity at a time, in per-vault threshold order.
 */
async function dispatch(
  id: number, token: string,
  opp: { priceMovePct: number; liqGrowthPct: number; liqPls: number },
  s: DiscoveryScreen,
  candidates: VaultRecord[],
): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const D = v.discovery;
    if (opp.priceMovePct < D.minPriceMovePct) return;
    if (opp.liqGrowthPct < D.minLiquidityGrowthPct) return;
    if (opp.liqPls < D.minLiquidityPls) return;
    if (s.buyTaxBps > D.maxBuyTaxBps) return;
    if (s.sellTaxBps > D.maxSellTaxBps) return;
    if (D.requireLpLock && s.lpLockedPct < 80) return;
    if (D.requireOwnerRenounced && !s.ownerRenounced) return;
    if (discoveryActions.has(v.address, id)) return;
    if (actionsToday(v.address) >= D.maxPerDay) return;

    if (D.mode === "notify") {
      discoveryActions.record(v.address, id, "notified");
      log("info", "discovery", `${v.address} notified of opportunity #${id} (${token})`);
      return;
    }

    await executeDiscoveryBuy(v, id, token);
  });
}

/**
 * "Buy Now" on a notified opportunity - the site records the request (see
 * site/lib/store.js's requestBuy, owner-signature gated same as a manual
 * position close), the keeper picks it up here. Only ever acts on an
 * opportunity that already passed the full screen and was already surfaced
 * to this vault (a discoveryActions row must exist) - a signed request
 * approves buying something this bot already vetted and showed, not an
 * arbitrary opportunity id.
 */
export type BuyRequest = { id: number; amountPls: number | null };

/** Exported for hunter.ts - the opportunity id queue is shared and source-
 * agnostic (the site's route returns every pending request for a vault
 * regardless of which detector produced the opportunity), so each detector
 * pulls the same list and filters to the rows it produced. amountPls is
 * null for a request made before "type your own amount" existed - callers
 * fall back to their own configured amount in that case. */
export async function fetchBuyRequests(vault: string): Promise<BuyRequest[]> {
  const api = process.env.CONFIG_API;
  if (!api) return [];
  try {
    const res = await fetchWithTimeout(`${api}/vaults/${vault}/discovery-buy-requests`);
    if (!res.ok) return [];
    return (await res.json()) as BuyRequest[];
  } catch (e) {
    log("warn", "discovery", `Buy-request fetch failed for ${vault}: ${(e as Error).message}`);
    return [];
  }
}

async function processBuyRequests(candidates: VaultRecord[]): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const requests = await fetchBuyRequests(v.address);
    for (const { id, amountPls } of requests) {
      if (discoveryActions.actionFor(v.address, id) === "bought") continue; // no double-buy
      const opp = opportunities.get(id);
      // Only ever act on this detector's own rows - hunter.ts runs the same
      // loop filtered to its own source, so a hunter-found candidate is
      // bought with hunter's sizing/budget, never discovery's.
      if (!opp || opp.verdict !== "pass" || (opp.source ?? "discovery") !== "discovery") continue;
      try {
        await executeDiscoveryBuy(v, id, opp.token, amountPls ?? undefined);
      } catch (e) {
        log("error", "discovery", `${v.address} buy request for opportunity #${id}: ${(e as Error).message}`);
      }
    }
  });
}

async function evaluateWatchedToken(
  w: { token: string; symbol: string; pair: string },
  strictest: {
    minPriceMovePct: number; minLiquidityGrowthPct: number; minLiquidityPls: number;
    maxBuyTaxBps: number; maxSellTaxBps: number; requireLpLock: boolean; requireOwnerRenounced: boolean;
  },
  from: number, dedupSince: number,
  candidates: VaultRecord[],
): Promise<void> {
  if (opportunities.recentForToken(w.token, dedupSince)) return;

  const rows = prices.since(w.token, from);
  if (rows.length < MIN_POINTS) return;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (first.price <= 0 || first.liq <= 0) return;

  // Hard gate, not configurable - see indicators.ts's looksLikeStablecoin.
  // Discovery's whole signal here is "price moved unusually in PLS terms" -
  // exactly what a USD-pegged token trivially produces whenever PLS/USD
  // itself moves, with nothing token-specific behind it at all.
  const usdPerPls = await plsUsd().catch(() => null);
  if (usdPerPls !== null && looksLikeStablecoin(rows.map((r) => r.price), usdPerPls)) return;

  const priceMovePct = ((last.price - first.price) / first.price) * 100;
  const liqGrowthPct = ((last.liq - first.liq) / first.liq) * 100;

  if (priceMovePct < strictest.minPriceMovePct) return;
  if (liqGrowthPct < strictest.minLiquidityGrowthPct) return;
  if (last.liq < strictest.minLiquidityPls) return;

  const s = await screenOpportunity(w.token, w.pair, strictest);
  const narrative = buildNarrative(w.symbol, priceMovePct, liqGrowthPct, last.liq, s);

  const id = opportunities.insert({
    token: w.token, priceMovePct, liqGrowthPct, liqPls: last.liq,
    buyTaxBps: s.buyTaxBps, sellTaxBps: s.sellTaxBps, lpLockedPct: s.lpLockedPct,
    ownerRenounced: s.ownerRenounced, sellable: s.sellable, verdict: s.verdict, reason: s.reason,
    narrative, priceAtDetection: last.price,
  });
  log("info", "discovery", `Opportunity #${id}: ${narrative}`);

  // A failed screen is still recorded and shown (so a notify-mode user can
  // see "this pumped but looks like a trap"), but never dispatched further -
  // no notify-count against maxPerDay, and never buyable.
  if (s.verdict !== "pass") return;

  await dispatch(id, w.token, { priceMovePct, liqGrowthPct, liqPls: last.liq }, s, candidates);
}

// How long a notified-but-untouched opportunity stays buyable at all,
// regardless of price. Someone clicking "Buy Now" on a notification from
// hours ago is acting on a stale signal, not the live one they think
// they're seeing - this is the hard backstop for that, independent of the
// price check below.
const STALE_TTL_MIN = 120;
// How far price can move away from where it was AT DETECTION before the
// original signal no longer describes reality. Direction depends on the
// strategy: Discovery chases a breakout already in progress, so a pullback
// means the move it reacted to has failed. Hunter buys an oversold dip, so
// the equivalent "already passed" signal is the opposite direction - price
// has already bounced back up, so it is no longer oversold.
const STALE_PRICE_MOVE_PCT = 15;

/**
 * Marks a notified (never bought) opportunity stale once it's no longer a
 * fair description of the market - either because too long has passed, or
 * because price has since moved enough that the reason it was flagged no
 * longer holds. Never touches an already-bought opportunity (nothing to
 * protect there) or a notify a vault has never even seen. Runs every tick
 * so the site's Buy Now button reflects this within one scan interval, not
 * only when someone happens to load the page.
 */
async function refreshStaleness(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Looks back twice the TTL purely so an opportunity sitting exactly at the
  // TTL boundary is still caught by this tick rather than the next one -
  // the TTL check below is what actually decides staleness by age.
  const candidates = opportunities.notifiedCandidatesForStaleness(STALE_TTL_MIN * 60 * 2);

  for (const c of candidates) {
    const ageMin = (nowSec - c.ts) / 60;
    if (ageMin >= STALE_TTL_MIN) {
      opportunities.markStale(c.id, `Notified ${Math.round(ageMin)} minutes ago - too much time has passed to trust the original signal.`);
      continue;
    }

    if (c.priceAtDetection === null || c.priceAtDetection <= 0) continue; // old row from before this existed - TTL is the only check available
    const latest = prices.latest(c.token);
    if (!latest || latest.price <= 0) continue;

    const movePctSinceDetection = ((latest.price - c.priceAtDetection) / c.priceAtDetection) * 100;
    if (c.source === "hunter" && movePctSinceDetection >= STALE_PRICE_MOVE_PCT) {
      opportunities.markStale(c.id, `Price is already up ${movePctSinceDetection.toFixed(0)}% since this was flagged as oversold - it's no longer the same dip.`);
    } else if (c.source !== "hunter" && movePctSinceDetection <= -STALE_PRICE_MOVE_PCT) {
      opportunities.markStale(c.id, `Price has pulled back ${Math.abs(movePctSinceDetection).toFixed(0)}% since this was flagged - the move it reacted to has since reversed.`);
    }
  }
}

export async function tick(): Promise<void> {
  await refreshStaleness();

  const candidates = registry.active().filter((v) => v.discovery.enabled);
  if (candidates.length === 0) return;

  // Screen once with the loosest bar any subscriber uses, then let each vault
  // apply its own thresholds in dispatch() - same "screen once, dispatch per
  // vault" shape launch.ts uses for new pairs.
  const strictest = {
    minPriceMovePct: Math.min(...candidates.map((c) => c.discovery.minPriceMovePct)),
    minLiquidityGrowthPct: Math.min(...candidates.map((c) => c.discovery.minLiquidityGrowthPct)),
    minLiquidityPls: Math.min(...candidates.map((c) => c.discovery.minLiquidityPls)),
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.discovery.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.discovery.maxSellTaxBps)),
    // Always false, NOT candidates.every(...) - that contradicted the "loosest
    // bar" comment above and was a real bug: the shared screen decides pass/
    // fail ONCE for every vault (see evaluateWatchedToken's `if (s.verdict
    // !== "pass") return`), so gating it on "every vault wants LP lock" meant
    // one vault still requiring it silently blocked the opportunity for every
    // OTHER vault too, even ones that had turned the requirement off.
    // screenOpportunity always computes the real lpLockedPct/ownerRenounced
    // regardless of this flag - dispatch() below already re-checks each
    // vault's own D.requireLpLock/D.requireOwnerRenounced against that real
    // data, which is the only place this decision should happen, per-vault.
    requireLpLock: false,
    requireOwnerRenounced: false,
  };

  const from = Math.floor(Date.now() / 1000) - DETECT_WINDOW_HOURS * 3600;
  const dedupSince = Math.floor(Date.now() / 1000) - DEDUP_HOURS * 3600;

  for (const w of watched.all()) {
    try {
      await evaluateWatchedToken(w, strictest, from, dedupSince, candidates);
    } catch (e) {
      log("error", "discovery", `${w.token}: ${(e as Error).message}`);
    }
  }

  await processBuyRequests(candidates);
}

export type { DiscoveryConfig };
