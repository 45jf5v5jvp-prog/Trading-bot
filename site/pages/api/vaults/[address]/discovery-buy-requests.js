const { pendingDiscoveryBuyIds } = require("../../../../lib/store");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/vaults/:address/discovery-buy-requests - public read, same
 * reasoning as close-requests: the keeper has to be able to read this for
 * every vault to act on it at all, and there's nothing sensitive in a list
 * of opportunity IDs. Polled by the keeper (discovery.ts) every tick.
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }

  res.status(200).json(pendingDiscoveryBuyIds(address));
}
