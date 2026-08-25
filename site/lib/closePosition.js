import { buildCloseMessage, buildCloseAllMessage } from "./auth";

/**
 * Signs and submits a request to close one open position. This does not sell
 * anything directly - only the keeper's key can call the vault's executeSwap
 * (onlyExecutor on chain). It just records the request; the keeper picks it
 * up on its own schedule, same as take-profit/stop-loss.
 */
export async function closePosition(getProvider, vaultAddress, positionId) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildCloseMessage(vaultAddress, positionId, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/positions/${positionId}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `close request failed (${res.status})`);
  return body;
}

/**
 * One signature, every currently-open position for this vault requested
 * closed - not one signature per position. Closing dozens of positions one
 * at a time doesn't scale (each needs its own wallet approval, which isn't
 * realistic to actually complete for a large count - confirmed live
 * 2026-08-24). The server resolves which positions "currently open" means
 * at request time, not a client-supplied list, so it can't go stale
 * between when this is called and when the keeper actually acts on it.
 */
export async function closeAllPositions(getProvider, vaultAddress) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildCloseAllMessage(vaultAddress, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/close-all-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `close-all request failed (${res.status})`);
  return body;
}
