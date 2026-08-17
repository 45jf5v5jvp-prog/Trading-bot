export async function loadHistory(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/history`);
  if (!res.ok) throw new Error(`could not load history (${res.status})`);
  return res.json();
}
