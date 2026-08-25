const { authorizeCloseAll } = require("../../../../lib/auth");
const { requestClose } = require("../../../../lib/store");
const { getPositions } = require("../../../../lib/keeperDb");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * POST /api/vaults/:address/close-all-requests - requests a manual close of
 * EVERY position currently open for this vault, in one signed action.
 *
 * Exists because closing one position at a time (positions/[id]/close.js)
 * doesn't scale - each close needs its own wallet signature, and a vault
 * with dozens of open positions means dozens of signature prompts, which
 * isn't realistic to actually get all the way through (confirmed live
 * 2026-08-24: a vault owner tried to close 50 positions individually and
 * most never got submitted at all). One signature here authorizes "close
 * everything open," and which positions that actually means is resolved
 * server-side, right now, from the keeper's own database - never trusting
 * a client-supplied list of IDs that could be stale by the time it's
 * acted on. Requires a signature from the vault's on-chain owner (see
 * lib/auth.js's authorizeCloseAll). Doesn't sell anything itself - only
 * the keeper's key can call the vault's executeSwap; this just records the
 * requests, the same way positions/[id]/close.js already does one at a
 * time.
 * Body: { timestampMs: number, signature: "0x..." }
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
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
    await authorizeCloseAll({ vaultAddress: vault, timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  const { open } = getPositions(vault);
  const now = Date.now();
  for (const p of open) requestClose(vault, p.id, now);
  res.status(200).json({ requested: true, count: open.length });
}
