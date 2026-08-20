const { getUnitPrice } = require("../../../../lib/livePrice");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/tokens/:token/price - live price of one whole token in the
 * chain's base currency, checked across every venue (V2, V3, V4). Backs the
 * Limit Order editor's "% from current" mode: the browser has no way to
 * reach the keeper's own database (V4 pricing needs it - see
 * lib/keeperDb.js's getV4PoolsForToken), so this is the one place that
 * logic lives, shared with the Portfolio panel and Current Holdings'
 * live P/L. Public read, same reasoning as every other endpoint here -
 * a price isn't sensitive, and needs to be visible to compute a target
 * before a vault is even created for anyone to own.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }
  const { token } = req.query;
  if (typeof token !== "string" || !ADDR_RE.test(token)) {
    res.status(400).json({ error: "token must be a 0x-prefixed address" });
    return;
  }
  try {
    const price = await getUnitPrice(token.toLowerCase());
    res.status(200).json({ price });
  } catch (e) {
    res.status(200).json({ price: null, error: e.message });
  }
}
