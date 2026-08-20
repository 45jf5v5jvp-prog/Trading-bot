const { authorizeAskBuy } = require("../../../../lib/auth");
const { requestAskBuy, pendingAskBuyRequests } = require("../../../../lib/store");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const { CHAIN } = require("../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * GET /api/vaults/:address/ask-buy-requests - public read, same reasoning as
 * discovery-buy-requests: the keeper has to be able to read this for every
 * vault to act on it, and there's nothing sensitive in a list of pending buy
 * requests. Polled by the keeper (ask.ts) every tick.
 *
 * POST /api/vaults/:address/ask-buy-requests - requests a manual buy of a
 * specific token and amount from Ask Icaria. Requires a signature from that
 * vault's on-chain owner (see lib/auth.js's authorizeAskBuy), same pattern
 * as every other manual action here. This does NOT buy anything itself -
 * only the keeper's key can call the vault's executeSwap. It just records
 * the request; the keeper picks it up on its own schedule.
 * Body: { token, amountPls, timestampMs, signature }
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method === "GET") {
    res.status(200).json(pendingAskBuyRequests(vault));
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }

  const { token, amountPls, timestampMs, signature } = req.body ?? {};
  if (typeof token !== "string" || !ADDR_RE.test(token)) {
    res.status(400).json({ error: "token must be a 0x-prefixed address" });
    return;
  }
  if (typeof amountPls !== "number" || !Number.isFinite(amountPls) || amountPls <= 0) {
    res.status(400).json({ error: "amountPls must be a positive number" });
    return;
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    res.status(400).json({ error: "signature is required" });
    return;
  }
  try {
    await authorizeAskBuy({ vaultAddress: vault, token: token.toLowerCase(), amountPls, timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  const id = requestAskBuy(vault, token, amountPls, Date.now());
  res.status(200).json({ requested: true, id });
}
