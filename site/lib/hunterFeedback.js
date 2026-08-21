import { id } from "ethers";
import { buildHunterFeedbackMessage } from "./auth";

/**
 * Signs and submits a piece of Hunter IQ feedback for this vault's own bot.
 * Same "site records the intent, keeper acts on it" split as everything
 * else here - this doesn't touch the keeper's database directly, it just
 * queues the text for hunter.ts's ingestOwnerFeedback to pick up on its own
 * schedule and turn into a lesson.
 */
export async function submitHunterFeedback(getProvider, vaultAddress, text) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const trimmed = text.trim();
  const message = buildHunterFeedbackMessage(vaultAddress, id(trimmed), timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/hunter-feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: trimmed, timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `feedback submission failed (${res.status})`);
  return body;
}
