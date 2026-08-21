/**
 * P&L attributable to trading ACTIVITY within a window - realized gains from
 * positions that closed in it, plus the current unrealized gain/loss on
 * positions opened in it and still open. `hours: null` means all time (no
 * cutoff at all). Deliberately not "vault value now minus vault value N
 * hours ago": that would need periodic value snapshots this repo doesn't
 * keep, and would silently be wrong on a fresh vault with no snapshot
 * history yet. This is honestly computable from data already on the
 * dashboard (positions.open/closed from /api/.../history), and answers the
 * question people actually have - "how has the bot done lately" - without
 * pretending to a precision the data doesn't support.
 */
export function pnlForWindow(history, hours, botFilter) {
  const cutoffSec = hours === null ? null : Math.floor(Date.now() / 1000) - hours * 3600;
  const matches = (bot) => !botFilter || bot === botFilter;
  let realizedPls = 0;
  let unrealizedPls = 0;
  let closedCount = 0;
  let openCount = 0;

  for (const p of history.positions.closed) {
    if (!matches(p.bot)) continue;
    if ((cutoffSec === null || p.closed_at >= cutoffSec) && p.proceeds_pls !== null && p.proceeds_pls !== undefined) {
      realizedPls += p.proceeds_pls - p.spent_pls;
      closedCount++;
    }
  }
  for (const p of history.positions.open) {
    if (!matches(p.bot)) continue;
    if ((cutoffSec === null || p.opened_at >= cutoffSec) && p.valueNowPls !== null && p.valueNowPls !== undefined) {
      unrealizedPls += p.valueNowPls - p.spent_pls;
      openCount++;
    }
  }

  return { realizedPls, unrealizedPls, totalPls: realizedPls + unrealizedPls, tradeCount: closedCount + openCount };
}
