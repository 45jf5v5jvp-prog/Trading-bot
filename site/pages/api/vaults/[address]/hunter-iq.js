const { getHunterLessons, getHunterTrades } = require("../../../../lib/keeperDb");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/vaults/:address/hunter-iq - public read, same reasoning as
 * history.js: nothing sensitive in a bot's own trade rationale or a vault
 * owner's coaching notes, and it needs to be visible without a separate
 * signed request just to look at a dashboard. Read-only against the
 * keeper's own database, same as history.js - see lib/keeperDb.js.
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
  res.status(200).json({
    trades: getHunterTrades(vault),
    lessons: getHunterLessons(vault),
  });
}
