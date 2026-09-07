import { formatEther } from "ethers";
import { db } from "./db.js";

/**
 * Position accounting and exit logic.
 *
 * These functions are the money math, so the pure ones are kept free of any
 * chain or database dependency and are unit tested directly. The rule engine
 * only ever bought; this adds the sell side: blended cost across multiple buys,
 * the exit signal (take profit / stop loss / trailing stop / time), and the
 * holding cap that stops a dip-buyer tipping the whole vault into one token.
 */

export interface SellTargets {
  tpPct?: number;        // take profit, 0/undefined disables
  slPct?: number;        // stop loss, 0/undefined disables
  trailPct?: number;     // trailing stop from peak, only arms once in profit
  timeExitMin?: number;  // hard time exit, 0/undefined disables
}

/** Blend a new buy into an existing position. Weighted average entry price. */
export function blend(prevSpent: number, prevTokensWei: bigint, addSpent: number, addTokensWei: bigint):
  { spent: number; tokensWei: bigint; tokens: number; entry: number } {
  const spent = prevSpent + addSpent;
  const tokensWei = prevTokensWei + addTokensWei;
  const tokens = Number(formatEther(tokensWei));
  const entry = tokens > 0 ? spent / tokens : 0;
  return { spent, tokensWei, tokens, entry };
}

export interface ExitInputs {
  tpPct: number | null;
  slPct: number | null;
  trailPct: number | null;
  timeExitMin: number | null;
  openedAt: number;   // unix seconds
  highWater: number;  // peak value/cost ratio ever seen (1.0 == break even)
  // Tiered trailing stop, optional - null on every bot except Hunter, which
  // is the only one that wants "take a quick small win eagerly, but let a
  // real move run further" rather than one fixed trail distance. Below
  // trailWidenAtPct of peak gain, tightTrailPct applies (tight, so a pump
  // that stalls early gets sold close to its peak, capturing most of a
  // quick win). Once the peak passes trailWidenAtPct, the wider trailPct
  // takes over instead (looser, so a real trend gets room to keep running
  // toward a bigger exit rather than getting stopped out on every wiggle).
  // Both are still just trailPct's own mechanism under the hood - only
  // which distance applies changes, not the arm condition (highWater > 1)
  // or how a hit is measured.
  tightTrailPct: number | null;
  trailWidenAtPct: number | null;
}

/**
 * Returns a human reason to sell, or null to hold. `ratio` is the position's
 * current mark-to-market value divided by what was spent on it, so 1.10 means
 * up 10%. The trailing stop only arms once the position has been in profit
 * (highWater > 1), so it never fires on a position that only ever fell.
 */
export function sellSignal(pos: ExitInputs, ratio: number, nowSec: number): string | null {
  // 0 means disabled for every exit, matching what the UI promises. Without
  // the > 0 guards, a take-profit of 0 would mean "sell at breakeven now" -
  // exactly wrong for the trail-only setup where TP is turned off so a
  // winner can run.
  const pnl = (ratio - 1) * 100;
  if (pos.tpPct != null && pos.tpPct > 0 && pnl >= pos.tpPct) return `take profit ${pnl.toFixed(1)}%`;
  if (pos.slPct != null && pos.slPct > 0 && pnl <= -pos.slPct) return `stop loss ${pnl.toFixed(1)}%`;
  const peakPnl = (pos.highWater - 1) * 100;
  let effectiveTrail = pos.trailPct;
  if (pos.tightTrailPct != null && pos.tightTrailPct > 0) {
    const widenAt = pos.trailWidenAtPct ?? Infinity;
    effectiveTrail = peakPnl < widenAt ? pos.tightTrailPct : (pos.trailPct ?? pos.tightTrailPct);
  }
  if (effectiveTrail != null && effectiveTrail > 0 && pos.highWater > 1 && ratio <= pos.highWater * (1 - effectiveTrail / 100))
    return `trailing stop ${pnl.toFixed(1)}% (peaked +${peakPnl.toFixed(1)}%)`;
  if (pos.timeExitMin != null && pos.timeExitMin > 0 && nowSec - pos.openedAt >= pos.timeExitMin * 60)
    return `time exit ${pnl.toFixed(1)}%`;
  return null;
}

/**
 * Would buying `buyPls` more of a token push the vault's holding of it above the
 * cap? All figures are PLS-denominated values. capPct of 0 (or >= 100) disables
 * the cap. Buying converts WPLS already in the vault into the token, so the
 * vault's total value is unchanged by the trade; only the token's share moves.
 */
export function exceedsHoldingCap(tokenValueAfterPls: number, totalValuePls: number, capPct: number): boolean {
  if (capPct <= 0 || capPct >= 100) return false;
  if (totalValuePls <= 0) return false;
  return tokenValueAfterPls > totalValuePls * (capPct / 100);
}

// ---- Database-backed position tracking (trading bot) -----------------------

interface OpenRow { id: number; spent_pls: number; tokens_held: string }

/**
 * Record a rule-bot buy. If an open position in this token already exists it is
 * averaged into it (blended cost); otherwise a new one is opened carrying the
 * rule's sell targets. Exits are then handled by positions.tick().
 */
export function recordBuy(a: {
  vault: string; token: string; spentPls: number; tokensOut: bigint; targets: SellTargets;
}): void {
  const vault = a.vault.toLowerCase();
  const token = a.token.toLowerCase();
  const row = db.prepare(
    `SELECT id, spent_pls, tokens_held FROM positions
     WHERE vault=? AND token=? AND bot='trading' AND status='open'`,
  ).get(vault, token) as OpenRow | undefined;

  if (row) {
    const b = blend(row.spent_pls, BigInt(row.tokens_held), a.spentPls, a.tokensOut);
    db.prepare(`UPDATE positions SET spent_pls=?, tokens_held=?, entry_price=? WHERE id=?`)
      .run(b.spent, b.tokensWei.toString(), b.entry, row.id);
  } else {
    const b = blend(0, 0n, a.spentPls, a.tokensOut);
    db.prepare(`INSERT INTO positions
      (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,tp_pct,sl_pct,trail_pct,time_exit_min,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open')`).run(
      vault, "trading", token, Math.floor(Date.now() / 1000), b.entry, b.spent, b.tokensWei.toString(), 1.0,
      a.targets.tpPct || null, a.targets.slPct || null, a.targets.trailPct || null, a.targets.timeExitMin || null,
    );
  }
}
