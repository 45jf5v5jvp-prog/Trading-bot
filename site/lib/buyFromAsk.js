import { buildAskBuyMessage } from "./auth";

/**
 * Signs and submits a request to buy a specific token/amount from Ask
 * Icaria. This does not buy anything directly - only the keeper's key can
 * call the vault's executeSwap (onlyExecutor on chain). It just records the
 * request; the keeper picks it up on its own schedule, same as every other
 * manual buy/close flow here.
 */
export async function buyFromAsk(getProvider, vaultAddress, token, amountPls) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildAskBuyMessage(vaultAddress, token, amountPls, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/ask-buy-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, amountPls, timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `buy request failed (${res.status})`);
  return body;
}
