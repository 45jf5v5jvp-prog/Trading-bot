import { buildReferralMessage } from "./auth";

/**
 * Signs and submits a vault's referrer binding, from an opaque referral
 * code (never a raw address - see lib/store.js). Uses the SAME
 * buildReferralMessage() the server checks the signature against (lib/auth.js)
 * rather than a second copy of the string template, so the two can never
 * drift apart - same pattern as saveConfig.js.
 */
export async function setReferral(getProvider, vaultAddress, code) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildReferralMessage(vaultAddress, code, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/referral`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `referral binding failed (${res.status})`);
  return body;
}

export async function loadReferral(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/referral`);
  if (!res.ok) throw new Error(`could not load referral (${res.status})`);
  return res.json();
}

/** A wallet's own referral link code - created lazily on first request. */
export async function loadReferralCode(wallet) {
  const res = await fetch(`/api/referrals/${wallet}/code`);
  if (!res.ok) throw new Error(`could not load referral code (${res.status})`);
  return res.json();
}

export async function loadReferralEarnings(wallet) {
  const res = await fetch(`/api/referrals/${wallet}/earnings`);
  if (!res.ok) throw new Error(`could not load referral earnings (${res.status})`);
  return res.json();
}
