import { buildMessage } from "./auth";

/**
 * Signs and submits a config update. Uses the SAME buildMessage() the server
 * checks the signature against (lib/auth.js) rather than a second copy of the
 * string template, so the two can never drift apart.
 */
export async function saveConfig(getProvider, vaultAddress, config) {
  const provider = getProvider();
  const signer = await provider.getSigner();
  const timestampMs = Date.now();
  const message = buildMessage(vaultAddress, timestampMs);
  const signature = await signer.signMessage(message);

  const res = await fetch(`/api/vaults/${vaultAddress}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, timestampMs, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `save failed (${res.status})`);
  return body;
}

export async function loadConfig(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/config`);
  if (!res.ok) throw new Error(`could not load config (${res.status})`);
  return res.json();
}
