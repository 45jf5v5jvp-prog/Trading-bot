export async function loadOpportunities(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/opportunities`);
  if (!res.ok) throw new Error(`could not load opportunities (${res.status})`);
  return res.json();
}
