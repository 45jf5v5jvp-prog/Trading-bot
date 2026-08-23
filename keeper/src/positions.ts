import { Contract, formatEther, formatUnits } from "ethers";
import { CFG } from "./config.js";
import { provider, routerRead, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { executeSwap, netOfExitCosts } from "./executor.js";
import { sellSignal } from "./portfolio.js";
import { mapLimit } from "./concurrency.js";
import { db, aiExitRequests } from "./db.js";
import { log } from "./log.js";

export interface OpenArgs {
  vault: string; bot: "launch" | "trading" | "snipe" | "limit" | "discovery" | "hunter" | "ask" | "deposit"; token: string;
  spentPls: number; tokensOut: bigint;
  tpPct: number; slPct: number; timeExitMin: number;
  trailPct?: number;
  /** Hunter Bot only - "limited" (fixed tp/sl/trailing/time, the default
   * everywhere else) or "full" (AI periodically re-judges whether to hold
   * or sell, on top of the same mandatory stop-loss - see hunter.ts's
   * reviewFullModePositions). Set once at open time so a later settings
   * change never retroactively changes how an already-open position is
   * managed. Undefined/null for every non-Hunter position. */
  exitMode?: "limited" | "full" | null;
  /** The transaction that actually bought these tokens, when known - see
   * db.ts's source_tx_hash migration comment. Optional and purely for
   * traceability; nothing reads it to decide behavior. */
  sourceTxHash?: string | null;
}

/**
 * A second, real bug this same investigation turned up: entry_price used to
 * be computed with formatEther, which always assumes 18 decimals - correct
 * for a typical fresh launch token, wrong for anything that isn't (HEX is 8,
 * plenty of tokens use 6 or 9). For those, entry_price came out off by
 * whatever power of ten separates the token's real decimals from 18 - a
 * position could show its AI exit judgment "down 100%" (a decimals-mismatch
 * artifact comparing entry_price on the wrong scale against prices.latest(),
 * which DOES use the token's real decimals - see prices.ts's readPair)
 * while the real close was a modest, ordinary loss. tokens_held itself was
 * never wrong (stored as the raw on-chain amount, decimals-agnostic), only
 * this human-readable price derived from it - real proceeds/P&L on close
 * were always correct, computed straight from actual swap output.
 */
export function openPosition(a: OpenArgs): void {
  const w = db.prepare("SELECT decimals FROM watched WHERE token = ?")
    .get(a.token.toLowerCase()) as { decimals: number } | undefined;
  const tokens = Number(formatUnits(a.tokensOut, w ? w.decimals : 18));
  const entry = tokens > 0 ? a.spentPls / tokens : 0;
  db.prepare(`INSERT INTO positions
    (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,tp_pct,sl_pct,trail_pct,time_exit_min,status,exit_mode,source_tx_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`).run(
    a.vault.toLowerCase(), a.bot, a.token.toLowerCase(), Math.floor(Date.now() / 1000),
    // high_water is the peak value/cost ratio, so it starts at 1.0 (break even),
    // not at the entry price. Trailing stops read it as a ratio.
    entry, a.spentPls, a.tokensOut.toString(), 1.0,
    a.tpPct, a.slPct || null, a.trailPct || null, a.timeExitMin || null, a.exitMode ?? null,
    a.sourceTxHash ?? null,
  );
}

interface Row {
  id: number; vault: string; token: string; opened_at: number; entry_price: number;
  spent_pls: number; tokens_held: string; high_water: number;
  bot: "launch" | "trading" | "snipe" | "limit" | "discovery" | "hunter" | "ask" | "deposit";
  tp_pct: number | null; sl_pct: number | null; trail_pct: number | null; time_exit_min: number | null;
  fail_count: number | null; exit_mode: string | null;
}

/**
 * How many STRUCTURAL exit failures a position gets before it is retired as
 * stuck. Structural means the failure cannot succeed on a later retry unless
 * the position's economics change - e.g. the proceeds are such dust that the
 * gas reimbursement can never fit the owner's share-of-trade cap. Retrying
 * those every tick forever is the storm that consumes the global trade rate
 * limit and crowds out real exits. Transient failures (rate limit hit, RPC
 * hiccups, gas price spikes) never count toward this.
 */
const MAX_STRUCTURAL_EXIT_FAILURES = 5;

/**
 * Consecutive ticks a position may be unpriceable (balance or quote calls
 * failing) before being retired - but ONLY counted on ticks where at least
 * one other position priced fine, which proves the RPC itself is healthy
 * and the problem is this token's contract (a rug that reverts balanceOf /
 * transfers is the classic case). An RPC outage therefore never retires
 * anything: no position prices during an outage, so nothing is counted.
 * With only one open position this check conservatively never fires.
 * 90 ticks at the position-check cadence is roughly half an hour.
 */
const UNPRICEABLE_STREAK_LIMIT = 90;
const unpriceableStreak = new Map<number, number>();

function retirePosition(id: number, token: string, reason: string): void {
  db.prepare(`UPDATE positions SET status='stuck', close_reason=? WHERE id=?`).run(reason, id);
  log("error", "positions", `${token}: ${reason}`);
}

/**
 * The PLS value of every open position in a vault, and the per-token breakdown.
 * Used by the holding cap: total vault value is this plus the vault's WPLS.
 */
export async function positionsValuePls(vault: string): Promise<{ total: number; byToken: Map<string, number> }> {
  const rows = db.prepare(`SELECT token, tokens_held FROM positions WHERE vault=? AND status='open'`)
    .all(vault.toLowerCase()) as { token: string; tokens_held: string }[];
  const byToken = new Map<string, number>();
  let total = 0;
  // Read-only quotes, safe to run concurrently regardless of vault grouping.
  // Tax-discounted same as markToMarket above - this feeds the holding-cap
  // check (exceedsHoldingCap), and an undiscounted quote overstates a taxed
  // token's real share of the vault just like it overstates a single
  // position's P&L.
  const values = await mapLimit(rows, CFG.keeperConcurrency, async (r) => {
    try {
      const held = BigInt(r.tokens_held);
      if (held === 0n) return null;
      const amounts: bigint[] = await routerRead.getAmountsOut(held, [r.token, CFG.wpls]);
      const quoted = amounts[amounts.length - 1]!;
      const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
        .get(r.token.toLowerCase()) as { sell_tax_bps: number } | undefined;
      const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
      const afterTax = (quoted * BigInt(10_000 - taxBps)) / 10_000n;
      const net = await netOfExitCosts(Number(formatEther(afterTax)), vault);
      return { token: r.token.toLowerCase(), value: net };
    } catch { return null; } // unpriceable right now, skip
  });
  for (const v of values) {
    if (!v) continue;
    byToken.set(v.token, (byToken.get(v.token) ?? 0) + v.value);
    total += v.value;
  }
  return { total, byToken };
}

type MarkResult =
  | { ok: true; value: number; held: bigint }
  // "vanished": the vault's real on-chain balance for this token is 0 even
  // though the position is still recorded open - the tokens left some way
  // other than a sell this bot ever called (most likely a malicious token
  // with a backdoor/blacklist mechanism triggered after the buy). This is
  // never a normal transient state for an open position: the row only
  // exists because the buy already verified a nonzero balance increase on
  // chain, so a later read of exactly 0 is a real signal, not noise.
  // "unpriceable": a quote call itself failed (RPC hiccup, no route right
  // now) - may well resolve on its own next tick, unlike "vanished."
  | { ok: false; reason: "vanished" | "unpriceable" };

/**
 * Marks a position against a live quote for the size actually held, not a mid
 * price. On a thin new pair those differ enormously, and exiting on mid price
 * means the stop fires far later than the user thinks it will.
 *
 * getAmountsOut is pure reserve arithmetic - it has no idea a token takes a
 * cut on transfer, so its quote is always too high for a taxed token. Left
 * undiscounted, this is exactly the bug executor.ts's own minOut calculation
 * already had to work around: a position in a token with real sell tax reads
 * as up far more than it actually is, which can fire take-profit (or hold
 * through what should have been a stop-loss) on a number nobody could
 * actually realize on a real sale. Discounted by the same measured
 * sell_tax_bps executor.ts uses for its own quote, so the ratio/high_water
 * this function feeds sellSignal() reflects what a real sale would return.
 */
async function markToMarket(r: Row): Promise<MarkResult> {
  let held: bigint;
  try {
    const erc = new Contract(r.token, ERC20_ABI, provider) as Dyn;
    held = await erc.balanceOf(r.vault);
  } catch {
    return { ok: false, reason: "unpriceable" };
  }
  if (held === 0n) return { ok: false, reason: "vanished" };
  try {
    const amounts: bigint[] = await routerRead.getAmountsOut(held, [r.token, CFG.wpls]);
    const quoted = amounts[amounts.length - 1]!;
    const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
      .get(r.token.toLowerCase()) as { sell_tax_bps: number } | undefined;
    const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
    const afterTax = (quoted * BigInt(10_000 - taxBps)) / 10_000n;
    // Tax-discounted is still a raw market quote - a real close also pays
    // the platform fee and gas reimbursement (see executor.ts's
    // netOfExitCosts), which this hadn't accounted for. Every TP/SL/
    // trailing/time check and every Auto Full AI judgment reads this value,
    // so leaving those costs out meant a position sitting at "roughly flat"
    // here was already a small guaranteed loss the moment it was really sold.
    const net = await netOfExitCosts(Number(formatEther(afterTax)), r.vault);
    return { ok: true, value: net, held };
  } catch {
    return { ok: false, reason: "unpriceable" };
  }
}

/**
 * Which open positions the owner has asked to close via the dashboard, for
 * one vault. Only the keeper's key can actually call the vault's
 * onlyExecutor executeSwap, so a dashboard button can't sell directly - it
 * writes a request the site stores, and this is that request read back.
 * Same CONFIG_API the bot settings come from; without it set, manual close
 * simply isn't available yet (falls back to config.json territory, which
 * has no place to record a close request either).
 */
async function fetchCloseRequests(vault: string): Promise<Set<number>> {
  const api = process.env.CONFIG_API;
  if (!api) return new Set();
  try {
    const res = await fetch(`${api}/vaults/${vault}/close-requests`);
    if (!res.ok) return new Set();
    const ids = (await res.json()) as number[];
    return new Set(ids);
  } catch (e) {
    log("warn", "positions", `Close-request fetch failed for ${vault}: ${(e as Error).message}`);
    return new Set();
  }
}

/**
 * `forceReason`, when non-null, closes the position immediately regardless
 * of what sellSignal() says and is used verbatim as the recorded
 * close_reason - either an owner-requested manual close, or (Auto Full
 * Hunter positions only) the AI's own exit judgment. Null means "no
 * override," the normal tp/sl/trailing/time check applies.
 */
async function checkAndClose(
  r: Row, now: number, forceReason: string | null,
): Promise<"priced" | "unpriceable" | "retired"> {
  const m = await markToMarket(r);
  if (!m.ok) {
    if (m.reason === "vanished") {
      log("error", "positions",
        `${r.token} in ${r.vault}: real on-chain balance is 0 but the position is still recorded ` +
        `open - the tokens left the vault without this bot ever selling them (most likely a ` +
        `malicious token). Marking stuck so this doesn't sit silently invisible.`);
      db.prepare(`UPDATE positions SET status='stuck', close_reason=? WHERE id=?`)
        .run("balance vanished: real on-chain balance is 0, not sold by this bot", r.id);
      return "retired";
    }
    log("warn", "positions", `${r.token} in ${r.vault}: could not get a live quote this tick, will retry`);
    return "unpriceable";
  }

  // ratio is current value / cost. 1.10 means up 10%. high_water is the peak
  // ratio ever seen, which the trailing stop measures the drawdown from.
  const ratio = r.spent_pls > 0 ? m.value / r.spent_pls : 0;
  const highWater = Math.max(r.high_water, ratio);
  if (highWater > r.high_water) {
    db.prepare(`UPDATE positions SET high_water=? WHERE id=?`).run(highWater, r.id);
  }

  // An owner-requested close or an AI exit judgment always wins over
  // whatever the normal exit targets say - it doesn't need to clear
  // take-profit/stop-loss/trailing/time thresholds first.
  const reason = forceReason ?? sellSignal(
    { tpPct: r.tp_pct, slPct: r.sl_pct, trailPct: r.trail_pct, timeExitMin: r.time_exit_min,
      openedAt: r.opened_at, highWater },
    ratio, now,
  );
  if (!reason) return "priced";

  log("info", "positions", `Closing ${r.token} for ${r.vault}: ${reason}`);
  const res = await executeSwap({
    vault: r.vault, bot: r.bot, path: [r.token, CFG.wpls],
    amountIn: m.held, tokenLabel: r.token,
    // On the way out, take the fill. A stop that will not execute is not a stop.
    slippageBps: Math.max(CFG.maxSlippageBps, 500),
  });

  if (res.ok) {
    db.prepare(`UPDATE positions SET status='closed',closed_at=?,proceeds_pls=?,close_reason=? WHERE id=?`)
      .run(now, Number(formatEther(res.amountOut)), reason, r.id);
    aiExitRequests.clear(r.id);
    return "priced";
  }

  const why = res.reason || "";
  log("error", "positions", `Exit failed for ${r.token}: ${why}`);
  if (why.includes("would revert")) {
    retirePosition(r.id, r.token,
      `cannot sell: ${why}. Tokens remain in the vault - the dashboard's emergency withdraw can still pull them.`);
    return "retired";
  }
  // Structural failures: retrying cannot help unless the position's
  // economics change (see MAX_STRUCTURAL_EXIT_FAILURES). Count persistently;
  // everything else (rate limit, gas spikes, RPC errors) is transient and
  // deliberately never counted.
  const structural = why.includes("over their share-of-trade limit") || why.includes("quote returned zero");
  if (structural) {
    const fails = (r.fail_count ?? 0) + 1;
    if (fails >= MAX_STRUCTURAL_EXIT_FAILURES) {
      retirePosition(r.id, r.token,
        `retired after ${fails} exit attempts that can never succeed (${why.slice(0, 100)}). ` +
        `Tokens remain in the vault - the dashboard's emergency withdraw can still pull them.`);
      return "retired";
    }
    db.prepare(`UPDATE positions SET fail_count=? WHERE id=?`).run(fails, r.id);
  }
  return "priced";
}

/**
 * Checks every open position for an exit. Grouped by vault and run concurrently
 * across vaults (bounded by KEEPER_CONCURRENCY); positions within the same
 * vault stay sequential, so two exits on one vault never race each other
 * through the vault's on-chain cooldown and waste gas on a doomed second send.
 */
export async function tick(): Promise<void> {
  const rows = db.prepare(`SELECT * FROM positions WHERE status='open'`).all() as Row[];
  const now = Math.floor(Date.now() / 1000);

  const byVault = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.vault.toLowerCase();
    const list = byVault.get(key);
    if (list) list.push(r); else byVault.set(key, [r]);
  }

  const aiExitReasons = new Map<number, string>(
    (db.prepare("SELECT position_id, reason FROM ai_exit_requests").all() as { position_id: number; reason: string }[])
      .map((r) => [r.position_id, `AI exit: ${r.reason}`]),
  );

  const outcomes: { id: number; token: string; outcome: "priced" | "unpriceable" | "retired" }[] = [];
  await mapLimit([...byVault.values()], CFG.keeperConcurrency, async (vaultRows) => {
    const closeIds = await fetchCloseRequests(vaultRows[0]!.vault);
    for (const r of vaultRows) {
      const forceReason = closeIds.has(r.id) ? "closed by owner" : (aiExitReasons.get(r.id) ?? null);
      const outcome = await checkAndClose(r, now, forceReason);
      outcomes.push({ id: r.id, token: r.token, outcome });
    }
  });

  // Peer-checked unpriceable-streak accounting (see UNPRICEABLE_STREAK_LIMIT).
  // Only ticks where at least one position priced fine count - that's the
  // proof the RPC is healthy and a persistent failure is the token's own
  // contract misbehaving, not the network.
  const anyPriced = outcomes.some((o) => o.outcome === "priced");
  for (const o of outcomes) {
    if (o.outcome === "priced" || o.outcome === "retired") {
      unpriceableStreak.delete(o.id);
      continue;
    }
    if (!anyPriced) continue; // possible RPC-wide problem - don't count this tick
    const n = (unpriceableStreak.get(o.id) ?? 0) + 1;
    if (n >= UNPRICEABLE_STREAK_LIMIT) {
      retirePosition(o.id, o.token,
        `unpriceable for ${n} consecutive checks while other positions priced fine - the token's ` +
        `contract likely reverts balance or quote calls (rug behavior). Tokens remain in the vault.`);
      unpriceableStreak.delete(o.id);
    } else {
      unpriceableStreak.set(o.id, n);
    }
  }
}

export { formatUnits };
