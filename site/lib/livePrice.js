const { JsonRpcProvider, Contract, formatEther, formatUnits, parseUnits } = require("ethers");
const { CHAIN } = require("./chain");
const { getV4PoolsForToken } = require("./keeperDb");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Server-side only, but the values are the same NEXT_PUBLIC_ chain config the
// browser uses - one source of truth in lib/chain.js.
const RPC_URL = CHAIN.rpcUrl;
const WRAPPED = CHAIN.wrapped;
const CHAIN_ID = CHAIN.chainId;
// Same V2 router the keeper itself trades through (keeper/.env ROUTER) - used
// here read-only, just to price open positions live.
const ROUTER = CHAIN.router;
const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory)"];

const V3_FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const V4_PROBE_ABI = [
  "function quote((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn) returns (uint256 amountOut)",
];

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

function isBaseCurrency(addr) {
  const a = addr.toLowerCase();
  return a === "0x0000000000000000000000000000000000000000" || a === WRAPPED.toLowerCase();
}

/** V2: the only venue on PulseChain, and the fastest/most common on
 * Robinhood too. Null (not thrown) if there's simply no pair. */
async function quoteV2(token, amountRaw) {
  try {
    const router = new Contract(ROUTER, ROUTER_ABI, getProvider());
    const amounts = await withTimeout(router.getAmountsOut(amountRaw, [token, WRAPPED]), 8000);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/** V3: checks every configured fee tier's pool (a token can have several)
 * and returns whichever prices best - same approach as the keeper's own
 * venues.ts. Unset FACTORY_V3/QUOTER_V3 (PulseChain, or a Robinhood
 * deployment that hasn't set the new NEXT_PUBLIC_ vars yet) short-circuits
 * to null with no RPC calls at all. */
async function quoteV3(token, amountRaw) {
  if (!CHAIN.factoryV3 || !CHAIN.quoterV3) return null;
  const provider = getProvider();
  const factory = new Contract(CHAIN.factoryV3, V3_FACTORY_ABI, provider);
  const quoter = new Contract(CHAIN.quoterV3, V3_QUOTER_ABI, provider);
  let best = null;
  for (const fee of CHAIN.v3FeeTiers) {
    try {
      const pool = await withTimeout(factory.getPool(token, WRAPPED, fee), 8000);
      if (/^0x0{40}$/i.test(pool)) continue;
      const result = await withTimeout(quoter.quoteExactInputSingle.staticCall(token, WRAPPED, fee, amountRaw, 0), 8000);
      const out = result[0];
      if (out > 0n && (best === null || out > best)) best = out;
    } catch { /* try the next tier */ }
  }
  return best;
}

/**
 * V4: unlike V2/V3 there is no on-chain "find the pool for this token"
 * lookup - a pool's full PoolKey IS its identity, so this reads the exact
 * same table the keeper's own scanner populated when it saw the pool's
 * Initialize event (see lib/keeperDb.js). A token the keeper has never
 * seen a V4 pool for (or one on a deployment with no V4 support at all)
 * simply has no rows here, and this returns null with no RPC calls.
 */
async function quoteV4(token, amountRaw) {
  if (!CHAIN.poolManager || !CHAIN.probeAddressV4) return null;
  const rows = getV4PoolsForToken(token);
  if (rows.length === 0) return null;
  const probe = new Contract(CHAIN.probeAddressV4, V4_PROBE_ABI, getProvider());
  let best = null;
  for (const row of rows) {
    try {
      const c0IsBase = isBaseCurrency(row.currency0);
      // Selling token for base: zeroForOne when the token itself is
      // currency0 - i.e. whichever side ISN'T the base currency.
      const zeroForOne = !c0IsBase;
      const key = {
        currency0: row.currency0, currency1: row.currency1,
        fee: row.fee, tickSpacing: row.tick_spacing, hooks: row.hooks,
      };
      const out = await withTimeout(probe.quote.staticCall(key, zeroForOne, amountRaw), 8000);
      if (out > 0n && (best === null || out > best)) best = out;
    } catch { /* try the next pool */ }
  }
  return best;
}

/**
 * Live value of a held token amount in the chain's base units (PLS or ETH),
 * quoted straight off whichever venue prices it best right now - V2, V3, or
 * V4 - not a cached/lagging price. Quoted at the size actually held, same
 * reasoning as the keeper's own positions.ts:markToMarket - a thin pair
 * prices worse at size than at a small probe amount, and the dashboard
 * should show what the position would actually sell for right now, not a
 * misleadingly good mid price.
 */
async function quotePlsValue(token, tokensHeldRaw) {
  const held = BigInt(tokensHeldRaw);
  if (held === 0n) return 0;
  const [v2, v3, v4] = await Promise.all([quoteV2(token, held), quoteV3(token, held), quoteV4(token, held)]);
  const candidates = [v2, v3, v4].filter((v) => v !== null);
  // No venue could price this at all (thin/rugged pair, or simply no pool
  // anywhere) - distinct from a real zero-value quote, and the caller needs
  // to tell those apart the same way the old single-venue code did (via a
  // thrown error, caught below).
  if (candidates.length === 0) throw new Error("no venue could price this token");
  const best = candidates.reduce((a, b) => (b > a ? b : a));
  return Number(formatEther(best));
}

/**
 * Adds live valueNowPls/pnlPct to each open position (field names kept as-is
 * for shape-compatibility with the keeper's history schema - the values are
 * in whichever base unit this chain uses). A quote failure (e.g. a pair that
 * has lost all liquidity) leaves those fields null rather than throwing -
 * one unpriceable token shouldn't blank out the whole dashboard.
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

/**
 * Live snapshot of one token's presence in a vault, for the Portfolio panel:
 * the vault's actual on-chain balance (decimals-correct) and what that
 * balance is worth right now, checked across every venue the chain
 * supports. A quote or balance failure returns nulls rather than throwing,
 * so one bad/illiquid token doesn't blank the whole panel.
 */
async function getPortfolioToken(vaultAddress, token) {
  const erc = new Contract(token, ERC20_ABI, getProvider());
  try {
    const [balanceRaw, decimals, symbol] = await Promise.all([
      withTimeout(erc.balanceOf(vaultAddress), 8000),
      withTimeout(erc.decimals(), 8000).catch(() => 18),
      withTimeout(erc.symbol(), 8000).catch(() => "???"),
    ]);
    const balance = Number(formatUnits(balanceRaw, decimals));
    let valuePls = null;
    if (balanceRaw > 0n) {
      try { valuePls = await quotePlsValue(token, balanceRaw.toString()); } catch { /* leave null */ }
    }
    return { token: token.toLowerCase(), symbol, decimals, balance, valuePls };
  } catch {
    return { token: token.toLowerCase(), symbol: "???", decimals: 18, balance: null, valuePls: null };
  }
}

async function getPortfolio(vaultAddress, tokens) {
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase()))];
  return Promise.all(distinct.map((t) => getPortfolioToken(vaultAddress, t)));
}

/**
 * Price of exactly one whole token, in base currency - what the Limit Order
 * editor's "% from current" mode shows and computes from. Same tri-venue
 * fallback as everything else here, so a token only tradeable on V3 or V4
 * still resolves a usable percent-mode target instead of silently failing.
 */
async function getUnitPrice(token) {
  const erc = new Contract(token, ERC20_ABI, getProvider());
  const decimals = await withTimeout(erc.decimals(), 8000).catch(() => 18);
  const oneUnit = parseUnits("1", decimals);
  const [v2, v3, v4] = await Promise.all([quoteV2(token, oneUnit), quoteV3(token, oneUnit), quoteV4(token, oneUnit)]);
  const candidates = [v2, v3, v4].filter((v) => v !== null);
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b > a ? b : a));
  return Number(formatEther(best));
}

module.exports = { priceOpenPositions, quotePlsValue, getPortfolio, getUnitPrice };
