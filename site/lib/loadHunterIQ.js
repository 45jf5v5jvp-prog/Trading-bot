export async function loadHunterIQ(vaultAddress) {
  const res = await fetch(`/api/vaults/${vaultAddress}/hunter-iq`);
  if (!res.ok) throw new Error(`could not load Hunter IQ (${res.status})`);
  return res.json();
}
