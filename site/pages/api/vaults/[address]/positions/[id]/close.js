const { authorizeClose } = require("../../../../../../lib/auth");
const { requestClose } = require("../../../../../../lib/store");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * POST /api/vaults/:address/positions/:id/close - requests a manual close of
 * one open position. Requires a signature from that vault's on-chain owner
 * (see lib/auth.js's authorizeClose). This does NOT sell anything itself -
 * it can't, only the keeper's key is allowed to call the vault's
 * executeSwap. It just records the request; the keeper picks it up on its
 * own schedule the same way it already checks for take-profit/stop-loss.
 * Body: { timestampMs: number, signature: "0x..." }
 */
export default async function handler(req, res) {
  const { address, id } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const positionId = Number(id);
  if (!Number.isInteger(positionId) || positionId <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }

  const { timestampMs, signature } = req.body ?? {};
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    res.status(400).json({ error: "signature is required" });
    return;
  }
  try {
    await authorizeClose({ vaultAddress: vault, positionId, timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  requestClose(vault, positionId, Date.now());
  res.status(200).json({ requested: true });
}
