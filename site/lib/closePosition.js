import { buildCloseMessage } from "./auth";

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
