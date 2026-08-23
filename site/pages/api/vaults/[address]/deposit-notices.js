const { authorizeDepositNotice } = require("../../../../lib/auth");
const { requestDepositNotice, pendingDepositNotices } = require("../../../../lib/store");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * GET /api/vaults/:address/deposit-notices - public read, same reasoning as
 * ask-buy-requests: the keeper has to be able to read this for every vault
 * to act on it, and there's nothing sensitive in a list of token addresses.
 * Polled by the keeper (deposits.ts) every tick.
 *
 * POST /api/vaults/:address/deposit-notices - tells the keeper "I just sent
 * this token to my vault, please start tracking it." Requires a signature
 * from that vault's on-chain owner (see lib/auth.js's authorizeDepositNotice),
 * same pattern as every other manual action here. This does NOT move any
 * tokens itself - the deposit is the owner's own separate wallet transfer,
 * sent directly to the vault address before this is ever called. It just
 * records the request; the keeper checks the vault's real on-chain balance
 * before ever creating a tracked position, so a false or premature notice
 * can't fabricate one.
 * Body: { token, timestampMs, signature }
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method === "GET") {
    res.status(200).json(pendingDepositNotices(vault));
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }

  const { token, timestampMs, signature } = req.body ?? {};
  if (typeof token !== "string" || !ADDR_RE.test(token)) {
    res.status(400).json({ error: "token must be a 0x-prefixed address" });
    return;
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    res.status(400).json({ error: "signature is required" });
    return;
  }
  try {
    await authorizeDepositNotice({ vaultAddress: vault, token: token.toLowerCase(), timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  const id = requestDepositNotice(vault, token, Date.now());
  res.status(200).json({ requested: true, id });
}
