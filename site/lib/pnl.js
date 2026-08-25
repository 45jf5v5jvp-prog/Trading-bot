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
 *
 * `hours: null` (lifetime/"All") is the one case NOT computed from
 * history.positions.closed - that list is capped at the vault's 100 most
 * recently OPENED positions (see keeperDb.js's getPositions), open and
 * closed combined, across every bot. Found live (2026-08-24): a vault
 * trading fast enough burns through 100 positions in about a day, so a
 * "lifetime" total derived from that list was quietly losing real, older
 * closed trades - both the round-trip count and the realized total - the
 * MORE active the vault got, exactly backwards from what "lifetime" should
 * mean. Uses history.lifetime instead (keeperDb.js's getLifetimeStats), a
 * genuinely unbounded aggregate. Unrealized/open-position figures still
 * come from history.positions.open even in the lifetime case - open
 * positions are bounded in practice by maxOpenPositions, nowhere near the
 * 100-row cap the way a fast bot's closed-trade history is.
 */
function pnlForWindow(history, hours, botFilter) {
  const matches = (bot) => !botFilter || bot === botFilter;

  if (hours === null) {
    const rows = (history.lifetime || []).filter((r) => matches(r.bot));
    const realizedPls = rows.reduce((sum, r) => sum + r.realizedPls, 0);
    const closedCount = rows.reduce((sum, r) => sum + r.closedCount, 0);
    let unrealizedPls = 0;
    let openCount = 0;
    for (const p of history.positions.open) {
      if (!matches(p.bot)) continue;
      if (p.valueNowPls !== null && p.valueNowPls !== undefined) {
        unrealizedPls += p.valueNowPls - p.spent_pls;
        openCount++;
      }
    }
    return {
      realizedPls, unrealizedPls, totalPls: realizedPls + unrealizedPls,
      tradeCount: closedCount + openCount,
      closedCount,
    };
  }

  const cutoffSec = Math.floor(Date.now() / 1000) - hours * 3600;
  let realizedPls = 0;
  let unrealizedPls = 0;
  let closedCount = 0;
  let openCount = 0;

  for (const p of history.positions.closed) {
    if (!matches(p.bot)) continue;
    if (p.closed_at >= cutoffSec && p.proceeds_pls !== null && p.proceeds_pls !== undefined) {
      realizedPls += p.proceeds_pls - p.spent_pls;
      closedCount++;
    }
  }
  for (const p of history.positions.open) {
    if (!matches(p.bot)) continue;
    if (p.opened_at >= cutoffSec && p.valueNowPls !== null && p.valueNowPls !== undefined) {
      unrealizedPls += p.valueNowPls - p.spent_pls;
      openCount++;
    }
  }

  return {
    realizedPls, unrealizedPls, totalPls: realizedPls + unrealizedPls,
    // "How many positions have anything to do with this window at all" -
    // opened or closed, matching PnlSnapshot's own "positions opened or
    // closed" copy. NOT the same thing as a completed round trip: a
    // position that closes doesn't add to this, it just moves from the
    // open side of the sum to the closed side, so this stays flat across a
    // close even though real money just came back. closedCount below is
    // the number that actually means "round trips completed."
    tradeCount: closedCount + openCount,
    closedCount,
  };
}

module.exports = { pnlForWindow };
