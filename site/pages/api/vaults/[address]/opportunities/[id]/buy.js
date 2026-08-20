const { authorizeBuyOpportunity } = require("../../../../../../lib/auth");
const { requestDiscoveryBuy } = require("../../../../../../lib/store");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * POST /api/vaults/:address/opportunities/:id/buy - requests a manual buy of
 * one Discovery/Hunter Bot opportunity, for an amount the owner chose
 * themselves. Requires a signature from that vault's on-chain owner (see
 * lib/auth.js's authorizeBuyOpportunity) binding the exact amount, same
 * pattern as Ask Icaria's buy request. This does NOT buy anything itself -
 * only the keeper's key can call the vault's executeSwap. It just records
 * the request; the keeper picks it up on its own schedule and, if the
 * opportunity still passed its screen, executes it - still subject to that
 * bot's own holding-cap and (for Hunter) allocation checks regardless of
 * what amount was requested here.
 * Body: { amountPls: number, timestampMs: number, signature: "0x..." }
 */
export default async function handler(req, res) {
  const { address, id } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const opportunityId = Number(id);
  if (!Number.isInteger(opportunityId) || opportunityId <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }

  const { amountPls, timestampMs, signature } = req.body ?? {};
  if (typeof amountPls !== "number" || !Number.isFinite(amountPls) || amountPls <= 0) {
    res.status(400).json({ error: "amountPls must be a positive number" });
    return;
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    res.status(400).json({ error: "signature is required" });
    return;
  }
  try {
    await authorizeBuyOpportunity({ vaultAddress: vault, opportunityId, amountPls, timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  requestDiscoveryBuy(vault, opportunityId, Date.now(), amountPls);
  res.status(200).json({ requested: true, amountPls });
}
