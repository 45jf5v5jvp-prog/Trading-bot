const { getReferrer, setReferrer, getWalletReferrer, resolveReferralCode } = require("../../../../lib/store");
const { authorizeReferral, defaultReadOwner } = require("../../../../lib/auth");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const CODE_RE = /^[a-f0-9]{16}$/i;
const { CHAIN } = require("../../../../lib/chain");
const RPC_URL = CHAIN.rpcUrl;

/**
 * GET  /api/vaults/:address/referral - public read. Only says WHETHER a
 *      vault has a referrer bound, never which wallet - the referrer's
 *      address is never returned over this API, only resolved server-side
 *      when binding (see POST below), so nothing here can be used to trace
 *      a referral link back to a specific address. Also the enforcement
 *      point for Referral Protections' auto-bind (see below) - this is
 *      called every time the dashboard loads any vault, so it fires
 *      without the owner needing to touch the referral field at all.
 *
 * POST /api/vaults/:address/referral - binds a referrer, once, permanently,
 *      from an opaque referral code rather than a raw address (see
 *      lib/store.js's referral_codes). Requires a signature from that
 *      vault's on-chain owner (see lib/auth.js) over a message binding this
 *      exact code. Body: { code: "...", timestampMs: number,
 *      signature: "0x..." }
 *
 * Referral Protections: the referrer actually recorded is never just
 * whatever code was submitted - lib/store.js's setReferrer resolves it
 * against the OWNER wallet's permanent lock instead, so a wallet that
 * already earned someone a referral credit on one vault can't dodge it by
 * creating a second vault under a different (or no) code. See setReferrer's
 * own comment for the full reasoning.
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method === "GET") {
    if (!getReferrer(vault)) {
      // No referrer on this specific vault yet - if its owner is already
      // locked to one from a different vault, bind it now automatically.
      // Best-effort: a failed on-chain read just means "can't auto-bind on
      // this pass," not an error - the dashboard still loads either way,
      // and the next GET (there's always a next one) tries again.
      try {
        const owner = await defaultReadOwner(vault, RPC_URL);
        const walletReferrer = getWalletReferrer(owner);
        if (walletReferrer) setReferrer(vault, walletReferrer, Date.now(), owner);
      } catch { /* best effort, see above */ }
    }
    res.status(200).json({ referred: Boolean(getReferrer(vault)) });
    return;
  }

  if (req.method === "POST") {
    const { code, timestampMs, signature } = req.body ?? {};
    if (typeof code !== "string" || !CODE_RE.test(code)) {
      res.status(400).json({ error: "code must be a referral code" });
      return;
    }
    if (typeof signature !== "string" || !signature.startsWith("0x")) {
      res.status(400).json({ error: "signature is required" });
      return;
    }
    let signer;
    try {
      ({ signer } = await authorizeReferral({ vaultAddress: vault, code, timestampMs, signature, rpcUrl: RPC_URL }));
    } catch (e) {
      res.status(403).json({ error: e.message });
      return;
    }
    const referrer = resolveReferralCode(code);
    if (!referrer) {
      res.status(400).json({ error: "unknown referral code" });
      return;
    }
    try {
      setReferrer(vault, referrer, Date.now(), signer);
    } catch (e) {
      res.status(409).json({ error: e.message });
      return;
    }
    res.status(200).json({ referred: true });
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `method ${req.method} not allowed` });
}
