const { getConfig } = require("../../../../lib/store");
const { getPortfolio } = require("../../../../lib/livePrice");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/vaults/:address/portfolio - public read, same reasoning as
 * history/config: nothing sensitive in a balance or a price. Tokens shown
 * are exactly the ones the vault's saved limit orders reference - that's
 * how the dashboard knows which arbitrary, non-launch tokens (HEX, INC,
 * PLSX, whatever the owner deposited) to bother querying at all, since
 * there's no on-chain way to enumerate "every token this address has ever
 * received."
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
  const config = getConfig(vault);
  const tokens = (config.limitOrders ?? []).map((o) => o.token);
  const portfolio = await getPortfolio(vault, tokens);
  res.status(200).json({ portfolio });
}
