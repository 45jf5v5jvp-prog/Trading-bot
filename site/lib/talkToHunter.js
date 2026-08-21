import { id } from "ethers";
import { buildHunterChatMessage } from "./auth";

/** Loads the chat thread so far for this vault. Public read, no signature -
 * same reasoning as loadHistory/loadHunterIQ. */
export async function loadHunterChat(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/hunter-chat`);
  if (!res.ok) throw new Error(`could not load chat (${res.status})`);
  return res.json(); // { messages }
}

/**
 * Signs and sends one message to this vault's own Hunter Bot, and returns
 * its live reply (or null if no ANTHROPIC_API_KEY is configured on this
 * deployment - the message still gets recorded and still shapes future
 * trades either way, see pages/api/vaults/[address]/hunter-chat.js).
 */
export async function sendHunterChatMessage(getProvider, vaultAddress, message) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const trimmed = message.trim();
  const signMessage = buildHunterChatMessage(vaultAddress, id(trimmed), timestampMs);
  const signature = await signer.signMessage(signMessage);

  const res = await fetch(`/api/vaults/${vaultAddress}/hunter-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: trimmed, timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `message failed (${res.status})`);
  return body; // { reply }
}
