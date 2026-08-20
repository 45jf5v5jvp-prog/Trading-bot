export async function loadPortfolio(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/portfolio`);
  if (!res.ok) throw new Error(`could not load portfolio (${res.status})`);
  return res.json();
}
