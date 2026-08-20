/**
 * Live price of one whole token, in the chain's base currency - backs the
 * Limit Order editor's "% from current" mode. Delegates to the server (see
 * pages/api/tokens/[token]/price.js) rather than quoting from the browser
 * directly: V4 pricing needs the keeper's own database (a V4 pool has no
 * on-chain lookup-by-token address the way V2/V3 do), which only the server
 * can reach, and doing it there means this one code path - not a
 * browser-side copy of it - is what stays correct as venues are added.
 */
export async function quoteTokenPrice(token) {
  const res = await fetch(`/api/tokens/${token}/price`);
  if (!res.ok) throw new Error(`could not fetch price (${res.status})`);
  const { price } = await res.json();
  if (price === null) throw new Error("no live price available for this token");
  return price;
}
