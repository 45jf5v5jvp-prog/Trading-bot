const { JsonRpcProvider, Contract, formatEther } = require("ethers");

// Same NEXT_PUBLIC_RPC_URL as lib/contracts.js (see its comment) - one value
// for the whole site, so it must stay safe to expose in the browser bundle
// even though this particular file only ever runs server-side.
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const WETH = process.env.NEXT_PUBLIC_WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "4663");
// Same router the keeper trades through (keeper/.env ROUTER) - used here
// read-only, just to price open positions live.
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";
const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory)"];

let providerSingleton;
function getProvider() {
  // Passing the chain ID makes this a "static network" provider - ethers
  // trusts it instead of probing the endpoint to auto-detect the network.
  // Without this, an unreachable RPC sends it into an internal
  // detect-network retry loop that never gives up and keeps a timer alive
  // in the background indefinitely, even after the calling request has
  // long since timed out and moved on.
  if (!providerSingleton) providerSingleton = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  return providerSingleton;
}

/**
 * A stalled RPC (or, in this sandbox, an egress-blocked one) should not hang
 * a request forever - node-fetch/undici's default timeout is much longer
 * than anyone should wait for a dashboard to load.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC call timed out after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Live ETH value of a held token amount, quoted straight off the router - not
 * a cached/lagging price. Quoted at the size actually held, same reasoning as
 * the keeper's own positions.ts:markToMarket - a thin pair prices worse at
 * size than at a small probe amount, and the dashboard should show what the
 * position would actually sell for right now, not a misleadingly good mid
 * price.
 */
async function quotePlsValue(token, tokensHeldRaw) {
  const held = BigInt(tokensHeldRaw);
  if (held === 0n) return 0;
  const router = new Contract(ROUTER, ROUTER_ABI, getProvider());
  const amounts = await withTimeout(router.getAmountsOut(held, [token, WETH]), 8000);
  return Number(formatEther(amounts[amounts.length - 1]));
}

/**
 * Adds live valueNowPls/pnlPct to each open position (field names kept as-is
 * for shape-compatibility with the keeper's own history API - values are ETH).
 * A quote failure (e.g. a pair that has lost all liquidity) leaves those
 * fields null rather than throwing - one unpriceable token shouldn't blank
 * out the whole dashboard.
 */
async function priceOpenPositions(openPositions) {
  return Promise.all(openPositions.map(async (p) => {
    try {
      const valueNowPls = await quotePlsValue(p.token, p.tokens_held);
      const pnlPct = p.spent_pls > 0 ? ((valueNowPls - p.spent_pls) / p.spent_pls) * 100 : null;
      return { ...p, valueNowPls, pnlPct };
    } catch {
      return { ...p, valueNowPls: null, pnlPct: null };
    }
  }));
}

module.exports = { priceOpenPositions, quotePlsValue };
