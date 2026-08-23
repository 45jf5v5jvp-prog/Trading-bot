import { buildDepositNoticeMessage } from "./auth";

/**
 * Signs and submits a "start tracking this token" notice after a manual
 * token deposit (see useVault.js's depositToken - the actual transfer has
 * already happened by the time this runs). This doesn't move anything
 * itself; the keeper checks the vault's real on-chain balance before ever
 * creating a tracked position, so this is purely "please go look."
 */
export async function notifyDeposit(getProvider, vaultAddress, token) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildDepositNoticeMessage(vaultAddress, token, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/deposit-notices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `deposit notice failed (${res.status})`);
  return body;
}
