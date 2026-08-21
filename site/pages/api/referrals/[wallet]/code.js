const { getOrCreateReferralCode } = require("../../../../lib/store");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/referrals/:wallet/code - a wallet's own referral code, created
 * the first time it's requested. No signature needed: this only ever hands
 * back (or lazily creates) the caller's OWN code, never resolves a code
 * back to an address, so there's nothing sensitive to gate here.
 */
export default function handler(req, res) {
  const { wallet } = req.query;
  if (typeof wallet !== "string" || !ADDR_RE.test(wallet)) {
    res.status(400).json({ error: "wallet must be a 0x-prefixed address" });
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }
  res.status(200).json({ code: getOrCreateReferralCode(wallet) });
}
