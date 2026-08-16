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
}

/**
 * Returns a human reason to sell, or null to hold. `ratio` is the position's
 * current mark-to-market value divided by what was spent on it, so 1.10 means
 * up 10%. The trailing stop only arms once the position has been in profit
 * (highWater > 1), so it never fires on a position that only ever fell.
 */
export function sellSignal(pos: ExitInputs, ratio: number, nowSec: number): string | null {
  const pnl = (ratio - 1) * 100;
  if (pos.tpPct != null && pnl >= pos.tpPct) return `take profit ${pnl.toFixed(1)}%`;
  if (pos.slPct != null && pnl <= -pos.slPct) return `stop loss ${pnl.toFixed(1)}%`;
  if (pos.trailPct != null && pos.highWater > 1 && ratio <= pos.highWater * (1 - pos.trailPct / 100))
    return `trailing stop ${pnl.toFixed(1)}% (peaked +${((pos.highWater - 1) * 100).toFixed(1)}%)`;
  if (pos.timeExitMin != null && nowSec - pos.openedAt >= pos.timeExitMin * 60)
    return `time exit ${pnl.toFixed(1)}%`;
  return null;
}

/**
 * Would buying `buyPls` more of a token push the vault's holding of it above the
 * cap? All figures are PLS-denominated values. capPct of 0 (or >= 100) disables
 * the cap. Buying converts WETH already in the vault into the token, so the
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
