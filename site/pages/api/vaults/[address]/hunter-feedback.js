const { id } = require("ethers");
const { authorizeHunterFeedback } = require("../../../../lib/auth");
const { requestHunterFeedback } = require("../../../../lib/store");
const { CHAIN } = require("../../../../lib/chain");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const RPC_URL = CHAIN.rpcUrl;
const MAX_LENGTH = 1000;

// Same hash both sides use - ethers' id() (keccak256 of the UTF-8 text)
// works identically in the browser and in this API route, no Node-only
// crypto module needed on either side.
function hashText(text) {
  return id(text);
}

/**
 * POST /api/vaults/:address/hunter-feedback - leave Hunter IQ feedback for
 * this vault's own bot. Requires a signature from the vault's on-chain
 * owner (see lib/auth.js's authorizeHunterFeedback) - this is coaching that
 * shapes real trading decisions, so only the owner gets to give it, same
 * bar as changing bot settings. Does not touch the keeper's database
 * directly - it just records the intent; the keeper ingests it on its own
 * schedule and is what actually turns it into a lesson (see
 * hunter.ts's ingestOwnerFeedback).
 * Body: { text: string, timestampMs: number, signature: "0x..." }
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

  const { text, timestampMs, signature } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  if (text.length > MAX_LENGTH) {
    res.status(400).json({ error: `text must be ${MAX_LENGTH} characters or fewer` });
    return;
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    res.status(400).json({ error: "signature is required" });
    return;
  }

  try {
    await authorizeHunterFeedback({ vaultAddress: vault, textHash: hashText(text.trim()), timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  const id = requestHunterFeedback(vault, text.trim(), Date.now());
  res.status(200).json({ requested: true, id });
}
