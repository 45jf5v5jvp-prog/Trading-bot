const { normalizeConfig } = require("../../../../lib/schema");
const { getConfig, setConfig } = require("../../../../lib/store");
const { authorizeConfigWrite } = require("../../../../lib/auth");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * GET  /api/vaults/:address/config  - public read. This is the exact endpoint
 *      the keeper's registry.ts CONFIG_API points at. Never requires auth:
 *      the keeper has to be able to read every vault's settings to run at all,
 *      and there is nothing sensitive in a config (no funds, no keys).
 *
 * POST /api/vaults/:address/config  - write. Requires a signature from that
 *      vault's on-chain owner (see lib/auth.js). Body:
 *        { config: {...}, timestampMs: number, signature: "0x..." }
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method === "GET") {
    res.status(200).json(getConfig(vault));
    return;
  }

  if (req.method === "POST") {
    const { config, timestampMs, signature } = req.body ?? {};
    if (typeof signature !== "string" || !signature.startsWith("0x")) {
      res.status(400).json({ error: "signature is required" });
      return;
    }
    try {
      await authorizeConfigWrite({ vaultAddress: vault, timestampMs, signature, rpcUrl: RPC_URL });
    } catch (e) {
      res.status(403).json({ error: e.message });
      return;
    }
    let normalized;
    try {
      normalized = normalizeConfig(config);
    } catch (e) {
      res.status(400).json({ error: e.message });
      return;
    }
    setConfig(vault, normalized, Date.now());
    res.status(200).json(normalized);
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `method ${req.method} not allowed` });
}
