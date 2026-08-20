import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { registry, type VaultRecord, type DiscoveryConfig } from "./registry.js";
import { watched, prices, opportunities, discoveryActions, db } from "./db.js";
import { simulate, lpLockedPct, checkOwnerRenounced } from "./screener.js";
import { executeSwap, executeSwapMultiVenue } from "./executor.js";
import { openPosition, positionsValuePls } from "./positions.js";
import { exceedsHoldingCap } from "./portfolio.js";
import { vaultWethBalance } from "./launch.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Discovery Bot: instead of waiting on a fresh launch or a user-chosen
 * address, this watches every token the keeper has ever seen (see prices.ts's
 * ensureWatched, now called unconditionally from launch.ts for every new
 * token) for a price move and a liquidity increase happening together over a
 * fixed 60-minute window. Liquidity growing alongside price is the cheap,
 * honest signal that real buying is happening rather than a wash-traded pump
 * on thin liquidity.
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
 *
 * Scope: V2-only, on purpose, matching rules.ts. This keeper's price history
 * (prices.ts's ensureWatched/readPair/pollAll) only ever samples V2 pair
 * reserves via factory.getPair + PAIR_ABI.getReserves - there is no V3 or V4
 * price-history sampling into the `prices` table yet, even though V2/V3/V4
 * EXECUTION is fully venue-aware elsewhere (venues.ts, snipe.ts, limits.ts).
 * Extending core price-history collection to V3/V4 (polling V3 pool state and
 * V4 PoolManager state on every price-poll tick, deciding which fee tier or
 * PoolKey to sample) is a separate, much larger undertaking and out of scope
 * here. Every token this module ever sees came from watched.all()/prices,
 * which are inherently V2-only in this repo already - so detection needs no
 * venue-awareness, and screening below calls only simulate() (the V2 probe),
 * never simulateV3/simulateV4, since a token discovery.ts sees is by
 * construction V2-quoted. The BUY side (executeDiscoveryBuy) is still vault-
 * kind aware - see its comment - because a multi-venue vault has no plain
 * executeSwap entry point even for an ordinary V2 trade.
 */

const DETECT_WINDOW_HOURS = 1;
// How long a token stays "already flagged" before the same kind of anomaly
// can produce a new opportunity row. Shorter than this and a token sitting
// above threshold for hours would spam a fresh row (and a fresh notify/buy
// decision) on every scan pass while nothing has actually changed.
const DEDUP_HOURS = 2;
const MIN_POINTS = 3;

interface DiscoveryScreen {
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
 */
async function screenOpportunity(
  token: string,
  pair: string,
  limits: { maxBuyTaxBps: number; maxSellTaxBps: number; requireLpLock: boolean; requireOwnerRenounced: boolean },
): Promise<DiscoveryScreen> {
  const out: DiscoveryScreen = {
    sellable: false, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 0,
    lpLockedPct: 0, ownerRenounced: true, verdict: "fail", reason: "",
  };

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
  if (limits.requireLpLock && out.lpLockedPct < 95)
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
    `in the last hour while liquidity grew ${liqGrowthPct.toFixed(0)}% to ${Math.round(liqPls).toLocaleString()} ETH.`;
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
 * request from notify mode (see fetchBuyRequests below). Always sized off
 * the vault's own configured discovery.amountPls - a manual request approves
 * buying THIS token with the amount already chosen for Discovery Bot, not an
 * arbitrary amount typed in on the spot.
 *
 * Vault-kind aware, same branching snipe.ts's fireSnipe uses for its buy: a
 * multiVenue/multiVenueV4 vault (v.kind !== "v2") has no plain executeSwap
 * entry point at all, even for an ordinary V2 trade - it only exposes
 * executeSwapMultiVenue. Every opportunity here is V2-quoted by construction
 * (see the module comment), so the multi-venue path always uses a "v2" venue.
 */
async function executeDiscoveryBuy(v: VaultRecord, id: number, token: string): Promise<void> {
  const D = v.discovery;
  if (D.amountPls <= 0) return;

  // Same holding-cap guard the Launch Bot uses. A token discovered this way
  // has no position yet, so its current value is whatever's already open.
  const { total: posValue, byToken } = await positionsValuePls(v.address);
  const totalValue = (await vaultWethBalance(v.address)) + posValue;
  const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
  if (exceedsHoldingCap(tokenNow + D.amountPls, totalValue, v.maxHoldingPct)) {
    log("info", "discovery", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping buy`);
    return;
  }

  const amountIn = parseEther(String(D.amountPls));
  // New attention on a token can move price fast, same reasoning as launch/snipe.
  const slippageBps = Math.min(CFG.maxSlippageBps, 300);

  const res = v.kind === "v2"
    ? await executeSwap({ vault: v.address, bot: "discovery", path: [CFG.weth, token], amountIn, tokenLabel: token, slippageBps })
    : await executeSwapMultiVenue({
        vault: v.address, bot: "discovery",
        venue: { kind: "v2", path: [CFG.weth, token] },
        amountIn, tokenLabel: token, slippageBps,
      });

  if (res.ok) {
    openPosition({
      vault: v.address, bot: "discovery", token,
      spentPls: D.amountPls, tokensOut: res.amountOut,
      tpPct: D.takeProfitPct, slPct: D.stopLossPct, trailPct: D.trailingStopPct, timeExitMin: D.timeExitMin,
    });
    discoveryActions.record(v.address, id, "bought", res.txHash);
    log("info", "discovery", `${v.address} bought ${D.amountPls} ETH of ${token} on opportunity #${id}`);
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
    if (D.requireLpLock && s.lpLockedPct < 95) return;
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
 * site/lib/store.js's requestDiscoveryBuy, owner-signature gated same as a
 * manual position close), the keeper picks it up here. Only ever acts on an
 * opportunity that already passed the full screen and was already surfaced
 * to this vault (a discoveryActions row must exist) - a signed request
 * approves buying something this bot already vetted and showed, not an
 * arbitrary opportunity id.
 */
async function fetchBuyRequests(vault: string): Promise<number[]> {
  const api = process.env.CONFIG_API;
  if (!api) return [];
  try {
    const res = await fetch(`${api}/vaults/${vault}/discovery-buy-requests`);
    if (!res.ok) return [];
    return (await res.json()) as number[];
  } catch (e) {
    log("warn", "discovery", `Buy-request fetch failed for ${vault}: ${(e as Error).message}`);
    return [];
  }
}

async function processBuyRequests(candidates: VaultRecord[]): Promise<void> {
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const ids = await fetchBuyRequests(v.address);
    for (const id of ids) {
      if (discoveryActions.actionFor(v.address, id) === "bought") continue; // no double-buy
      const opp = opportunities.get(id);
      if (!opp || opp.verdict !== "pass") continue;
      try {
        await executeDiscoveryBuy(v, id, opp.token);
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
    narrative,
  });
  log("info", "discovery", `Opportunity #${id}: ${narrative}`);

  // A failed screen is still recorded and shown (so a notify-mode user can
  // see "this pumped but looks like a trap"), but never dispatched further -
  // no notify-count against maxPerDay, and never buyable.
  if (s.verdict !== "pass") return;

  await dispatch(id, w.token, { priceMovePct, liqGrowthPct, liqPls: last.liq }, s, candidates);
}

export async function tick(): Promise<void> {
  const candidates = registry.active().filter((v) => v.discovery.enabled);
  if (candidates.length === 0) return;

  // Screen once with the loosest bar any subscriber uses, then let each vault
  // apply its own thresholds in dispatch() - same "screen once, dispatch per
  // vault" shape launch.ts uses for new tokens.
  const strictest = {
    minPriceMovePct: Math.min(...candidates.map((c) => c.discovery.minPriceMovePct)),
    minLiquidityGrowthPct: Math.min(...candidates.map((c) => c.discovery.minLiquidityGrowthPct)),
    minLiquidityPls: Math.min(...candidates.map((c) => c.discovery.minLiquidityPls)),
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.discovery.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.discovery.maxSellTaxBps)),
    requireLpLock: candidates.every((c) => c.discovery.requireLpLock),
    requireOwnerRenounced: candidates.every((c) => c.discovery.requireOwnerRenounced),
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
