import { Contract, formatEther, formatUnits } from "ethers";
import { CFG } from "./config.js";
import { provider, routerRead, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { executeSwap } from "./executor.js";
import { sellSignal } from "./portfolio.js";
import { mapLimit } from "./concurrency.js";
import { db } from "./db.js";
import { log } from "./log.js";

export interface OpenArgs {
  vault: string; bot: "launch" | "trading"; token: string;
  spentPls: number; tokensOut: bigint;
  tpPct: number; slPct: number; timeExitMin: number;
  trailPct?: number;
}

export function openPosition(a: OpenArgs): void {
  const tokens = Number(formatEther(a.tokensOut));
  const entry = tokens > 0 ? a.spentPls / tokens : 0;
  db.prepare(`INSERT INTO positions
    (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,tp_pct,sl_pct,trail_pct,time_exit_min,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open')`).run(
    a.vault.toLowerCase(), a.bot, a.token.toLowerCase(), Math.floor(Date.now() / 1000),
    // high_water is the peak value/cost ratio, so it starts at 1.0 (break even),
    // not at the entry price. Trailing stops read it as a ratio.
    entry, a.spentPls, a.tokensOut.toString(), 1.0,
    a.tpPct, a.slPct || null, a.trailPct || null, a.timeExitMin || null,
  );
}

interface Row {
  id: number; vault: string; token: string; opened_at: number; entry_price: number;
  spent_pls: number; tokens_held: string; high_water: number;
  tp_pct: number | null; sl_pct: number | null; trail_pct: number | null; time_exit_min: number | null;
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
  const values = await mapLimit(rows, CFG.keeperConcurrency, async (r) => {
    try {
      const held = BigInt(r.tokens_held);
      if (held === 0n) return null;
      const amounts: bigint[] = await routerRead.getAmountsOut(held, [r.token, CFG.wpls]);
      return { token: r.token.toLowerCase(), value: Number(formatEther(amounts[amounts.length - 1]!)) };
    } catch { return null; } // unpriceable right now, skip
  });
  for (const v of values) {
    if (!v) continue;
    byToken.set(v.token, (byToken.get(v.token) ?? 0) + v.value);
    total += v.value;
  }
  return { total, byToken };
}

/**
 * Marks a position against a live quote for the size actually held, not a mid
 * price. On a thin new pair those differ enormously, and exiting on mid price
 * means the stop fires far later than the user thinks it will.
 */
async function markToMarket(r: Row): Promise<{ value: number; held: bigint } | null> {
  try {
    const erc = new Contract(r.token, ERC20_ABI, provider) as Dyn;
    const held: bigint = await erc.balanceOf(r.vault);
    if (held === 0n) return null;
    const amounts: bigint[] = await routerRead.getAmountsOut(held, [r.token, CFG.wpls]);
    return { value: Number(formatEther(amounts[amounts.length - 1]!)), held };
  } catch {
    return null;
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

async function checkAndClose(r: Row, now: number, manualClose: boolean): Promise<void> {
  const m = await markToMarket(r);
  if (!m) return;

  // ratio is current value / cost. 1.10 means up 10%. high_water is the peak
  // ratio ever seen, which the trailing stop measures the drawdown from.
  const ratio = r.spent_pls > 0 ? m.value / r.spent_pls : 0;
  const highWater = Math.max(r.high_water, ratio);
  if (highWater > r.high_water) {
    db.prepare(`UPDATE positions SET high_water=? WHERE id=?`).run(highWater, r.id);
  }

  // An owner-requested close always wins over whatever the normal exit
  // targets say - they asked for it directly, so it doesn't need to clear
  // take-profit/stop-loss/trailing/time thresholds first.
  const reason = manualClose ? "closed by owner" : sellSignal(
    { tpPct: r.tp_pct, slPct: r.sl_pct, trailPct: r.trail_pct, timeExitMin: r.time_exit_min,
      openedAt: r.opened_at, highWater },
    ratio, now,
  );
  if (!reason) return;

  log("info", "positions", `Closing ${r.token} for ${r.vault}: ${reason}`);
  const res = await executeSwap({
    vault: r.vault, bot: "launch", path: [r.token, CFG.wpls],
    amountIn: m.held, tokenLabel: r.token,
    // On the way out, take the fill. A stop that will not execute is not a stop.
    slippageBps: Math.max(CFG.maxSlippageBps, 500),
  });

  if (res.ok) {
    db.prepare(`UPDATE positions SET status='closed',closed_at=?,proceeds_pls=?,close_reason=? WHERE id=?`)
      .run(now, Number(formatEther(res.amountOut)), reason, r.id);
  } else {
    log("error", "positions", `Exit failed for ${r.token}: ${res.reason}`);
    if ((res.reason || "").includes("would revert")) {
      db.prepare(`UPDATE positions SET status='stuck',close_reason=? WHERE id=?`)
        .run(`cannot sell: ${res.reason}`, r.id);
      log("error", "positions", `${r.token} appears unsellable. Marked stuck, will stop retrying.`);
    }
  }
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

  await mapLimit([...byVault.values()], CFG.keeperConcurrency, async (vaultRows) => {
    const closeIds = await fetchCloseRequests(vaultRows[0]!.vault);
    for (const r of vaultRows) await checkAndClose(r, now, closeIds.has(r.id));
  });
}

export { formatUnits };
