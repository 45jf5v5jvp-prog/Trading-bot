const { getReferrer, setReferrer } = require("../../../../lib/store");
const { authorizeReferral } = require("../../../../lib/auth");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * GET  /api/vaults/:address/referral - public read. Shows a vault's bound
 *      referrer, or null if it doesn't have one - nothing sensitive here.
 *
 * POST /api/vaults/:address/referral - binds a referrer, once, permanently.
 *      Requires a signature from that vault's on-chain owner (see
 *      lib/auth.js) - it's the owner's own fee being split, so only they can
 *      authorize it. Body: { referrer: "0x...", timestampMs: number,
 *      signature: "0x..." }
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method === "GET") {
    res.status(200).json({ referrer: getReferrer(vault) });
    return;
  }

  if (req.method === "POST") {
    const { referrer, timestampMs, signature } = req.body ?? {};
    if (typeof referrer !== "string" || !ADDR_RE.test(referrer)) {
      res.status(400).json({ error: "referrer must be a 0x-prefixed address" });
      return;
    }
    if (typeof signature !== "string" || !signature.startsWith("0x")) {
      res.status(400).json({ error: "signature is required" });
      return;
    }
    try {
      await authorizeReferral({ vaultAddress: vault, referrer, timestampMs, signature, rpcUrl: RPC_URL });
    } catch (e) {
      res.status(403).json({ error: e.message });
      return;
    }
    try {
      setReferrer(vault, referrer, Date.now());
    } catch (e) {
      res.status(409).json({ error: e.message });
      return;
    }
    res.status(200).json({ referrer: getReferrer(vault) });
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `method ${req.method} not allowed` });
}
