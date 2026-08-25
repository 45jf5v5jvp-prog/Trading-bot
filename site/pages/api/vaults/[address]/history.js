const { getPositions, getLifetimeStats, getRecentFires } = require("../../../../lib/keeperDb");
const { priceOpenPositions, attachSymbols, attachRealBalance } = require("../../../../lib/livePrice");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/vaults/:address/history - public read, same reasoning as the
 * config endpoint: nothing sensitive in trade history (no funds, no keys),
 * and it needs to be visible to the vault's owner without a separate signed
 * request just to look at a dashboard. Read-only against the keeper's own
 * database - see lib/keeperDb.js. Open positions additionally get a live
 * on-chain quote (valueNowPls, pnlPct) - see lib/livePrice.js - computed
 * fresh on every request rather than cached, so the dashboard reflects
 * what the position is actually worth right now. Closed positions don't
 * need a live quote (nothing to price - the trade is over, or a rugged one
 * has no live price to trust anyway), but still get a token symbol looked
 * up so a Closed/Rugged Positions row says what token it actually was,
 * not just a truncated address. Same for Recent Trades' fires - every
 * token shown anywhere on the dashboard should say what it is, not just a
 * truncated address, consistently.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();
  const positions = getPositions(vault);
  const [open, closedWithSymbols, fires] = await Promise.all([
    priceOpenPositions(positions.open, vault),
    attachSymbols(positions.closed),
    attachSymbols(getRecentFires(vault)),
  ]);
  // A live balanceOf check on top of the symbol lookup, stuck positions
  // only - see attachRealBalance's own comment. Confirmed-empty ones are
  // filtered out entirely below rather than shown as if still pending.
  const closedChecked = await attachRealBalance(closedWithSymbols, vault);
  const closed = closedChecked.filter((p) => !(p.status === "stuck" && p.hasRealBalance === false));
  res.status(200).json({
    positions: { open, closed },
    fires,
    // True lifetime closed-trade totals per bot, unbounded - NOT the same
    // as summing `closed` above, which (like `open`) only ever holds the
    // vault's 100 most recently opened positions - see keeperDb.js's
    // getLifetimeStats for why that matters for a fast-trading vault.
    lifetime: getLifetimeStats(vault),
  });
}
