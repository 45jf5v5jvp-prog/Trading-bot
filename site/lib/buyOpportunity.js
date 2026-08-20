import { buildBuyOpportunityMessage } from "./auth";

/**
 * Signs and submits a request to buy one Discovery Bot opportunity now. This
 * does not buy anything directly - only the keeper's key can call the
 * vault's executeSwap (onlyExecutor on chain). It just records the request;
 * the keeper picks it up on its own schedule, same as a manual position close.
 */
export async function buyOpportunity(getProvider, vaultAddress, opportunityId) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildBuyOpportunityMessage(vaultAddress, opportunityId, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/opportunities/${opportunityId}/buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `buy request failed (${res.status})`);
  return body;
}
