const { getPositions, getRecentFires } = require("../../../../lib/keeperDb");
const { priceOpenPositions } = require("../../../../lib/livePrice");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/vaults/:address/history - public read, same reasoning as the
 * config endpoint: nothing sensitive in trade history (no funds, no keys),
 * and it needs to be visible to the vault's owner without a separate signed
 * request just to look at a dashboard. Read-only against the keeper's own
 * database - see lib/keeperDb.js. Open positions additionally get a live
 * on-chain quote (valueNowPls, pnlPct) - see lib/livePrice.js - computed
 * fresh on every request rather than cached, so the dashboard reflects
 * what the position is actually worth right now.
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
  const open = await priceOpenPositions(positions.open, vault);
  res.status(200).json({
    positions: { open, closed: positions.closed },
    fires: getRecentFires(vault),
  });
}
