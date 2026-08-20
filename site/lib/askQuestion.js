/**
 * Asks Icaria about a token address the user typed in. Public read, no
 * signature required - just runs the mechanical checks and, if configured,
 * an AI read on top. Buying is a separate, signed step (see buyFromAsk.js).
 */
export async function askQuestion(vaultAddress, token, question) {
  const res = await fetch(`/api/vaults/${vaultAddress}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, question }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `ask failed (${res.status})`);
  return body; // { profile, answer, error }
}
