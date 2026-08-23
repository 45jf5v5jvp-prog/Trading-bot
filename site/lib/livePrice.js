const { JsonRpcProvider, Contract, formatEther, formatUnits, parseUnits } = require("ethers");
const { CHAIN } = require("./chain");
const { getV4PoolsForToken, getSellTaxBps } = require("./keeperDb");

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
const VAULT_FEE_ABI = [
  "function feeBps() view returns (uint16)",
  "function maxGasFeeBps() view returns (uint16)",
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

/**
 * Runs fn over items with at most `limit` in flight at once, instead of the
 * unbounded Promise.all this replaced. A vault with many open positions (or
 * many distinct held tokens) used to fire one full price lookup per item
 * simultaneously - each one several RPC calls - which is fine against a
 * dedicated node but reliably starves the shared public rpc.pulsechain.com
 * endpoint: a single eth_blockNumber call answers instantly, but a burst of
 * a dozen-plus concurrent getAmountsOut calls (on top of the keeper hitting
 * the same endpoint from its own scan loop at the same time) pushed every
 * one of them past the 8s timeout and made positions read as "no liquidity"
 * that had nothing wrong with them. Same shape as the keeper's own
 * concurrency.ts:mapLimit, just duplicated here since the site is a
 * separate JS project with no shared package between them.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
// Deliberately small - this isn't trying to be fast, it's trying not to be
// the thing that tips a shared, rate-limited public RPC over. Tune down
// further (or up, on a dedicated node) if the timeout pattern persists.
const RPC_CONCURRENCY = 4;

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
  } catch (e) {
    // A revert here (no pair, or a pair with reserves too thin to quote) and
    // an RPC-level failure (timeout, rate limit, connection drop) both land
    // in this catch and both return null the same way - which is correct
    // for pricing (either way there's no usable quote right now), but meant
    // there was previously no way to tell a genuinely illiquid/rugged token
    // apart from "the shared public RPC hiccuped" from server logs alone.
    // Logged, not swallowed, so a mass "no liquidity" reading across many
    // unrelated tokens at once (an RPC problem) is distinguishable from real
    // liquidity loss (which wouldn't correlate across tokens like that).
    console.error(`[livePrice] quoteV2(${token}) failed: ${e?.message || e}`);
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

// A vault's feeBps/maxGasFeeBps are an owner setting, not something that
// changes trade-to-trade, so caching them for a while avoids two extra RPC
// calls on every single position/portfolio-token repriced on every dashboard
// poll. Gas price gets a much shorter TTL since it actually moves.
const vaultFeeCache = new Map();
const VAULT_FEE_TTL_MS = 10 * 60 * 1000;
let cachedGasPriceWei = null;
let cachedGasPriceAt = 0;
const GAS_PRICE_TTL_MS = 30_000;

async function cachedVaultFees(vaultAddress) {
  const key = vaultAddress.toLowerCase();
  const cached = vaultFeeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < VAULT_FEE_TTL_MS) return cached;
  const vault = new Contract(vaultAddress, VAULT_FEE_ABI, getProvider());
  const [feeBps, maxGasFeeBps] = await Promise.all([
    withTimeout(vault.feeBps(), 8000),
    withTimeout(vault.maxGasFeeBps(), 8000),
  ]);
  const entry = { feeBps: Number(feeBps), maxGasFeeBps: Number(maxGasFeeBps), at: now };
  vaultFeeCache.set(key, entry);
  return entry;
}

async function cachedGasPrice() {
  const now = Date.now();
  if (cachedGasPriceWei !== null && now - cachedGasPriceAt < GAS_PRICE_TTL_MS) return cachedGasPriceWei;
  const fee = await withTimeout(getProvider().getFeeData(), 8000);
  cachedGasPriceWei = fee.gasPrice ?? 0n;
  cachedGasPriceAt = now;
  return cachedGasPriceWei;
}

/**
 * What a real close of this vault's position would actually keep, in PLS,
 * after the platform fee and gas reimbursement every real exit pays (see
 * BotVault.sol's executeSwap, non-payingIn branch, and keeper/src/
 * executor.ts's identical netOfExitCosts) - a raw AMM quote says what the
 * market would give for the tokens, not what the vault keeps once those two
 * charges come out on the way out. Without this, the dashboard could show a
 * position as roughly flat or up right up until the keeper actually closed
 * it at a real, structural loss - the same "displayed P&L doesn't match
 * reality" shape as the tax-blindness bug above, different cause. Falls
 * back to the raw value on any RPC failure rather than blanking the number.
 */
async function netOfExitCostsPls(rawValuePls, vaultAddress) {
  if (rawValuePls <= 0) return rawValuePls;
  try {
    const [{ feeBps, maxGasFeeBps }, gasPrice] = await Promise.all([
      cachedVaultFees(vaultAddress), cachedGasPrice(),
    ]);
    const gasFeePls = Number(formatEther((400_000n * gasPrice * 115n) / 100n));
    const gasFeeCappedPls = Math.min(gasFeePls, (rawValuePls * maxGasFeeBps) / 10_000);
    const feePls = (rawValuePls * feeBps) / 10_000;
    return Math.max(0, rawValuePls - feePls - gasFeeCappedPls);
  } catch {
    return rawValuePls;
  }
}

/**
 * Live value of a held token amount in the chain's base units (PLS or ETH),
 * quoted straight off whichever venue prices it best right now - V2, V3, or
 * V4 - not a cached/lagging price. Quoted at the size actually held, same
 * reasoning as the keeper's own positions.ts:markToMarket - a thin pair
 * prices worse at size than at a small probe amount, and the dashboard
 * should show what the position would actually sell for right now, not a
 * misleadingly good mid price.
 *
 * The V2 leg is discounted by the keeper's own measured sell tax before
 * comparing venues, same fix as positions.ts's markToMarket and hunter.ts's
 * reviewFullModePositions: getAmountsOut is pure reserve arithmetic with no
 * idea a token takes a cut on transfer, so an undiscounted quote reads as
 * far more than a real sale would return - which is exactly what let a
 * position display as up 40% on this dashboard while actually closing at a
 * real loss. V3/V4 aren't discounted since this codebase has no way to
 * measure tax on those venues (see askIcaria.js's simulateV3/simulateV4 -
 * their probes don't return a tax figure at all, same limitation the
 * keeper's own screener.ts has).
 */
async function quotePlsValue(token, tokensHeldRaw, vaultAddress) {
  const held = BigInt(tokensHeldRaw);
  if (held === 0n) return 0;
  const [v2, v3, v4] = await Promise.all([quoteV2(token, held), quoteV3(token, held), quoteV4(token, held)]);
  const sellTaxBps = getSellTaxBps(token);
  const v2AfterTax = v2 !== null && sellTaxBps
    ? (v2 * BigInt(10_000 - Math.min(sellTaxBps, 5000))) / 10_000n
    : v2;
  const candidates = [v2AfterTax, v3, v4].filter((v) => v !== null);
  // No venue could price this at all (thin/rugged pair, or simply no pool
  // anywhere) - distinct from a real zero-value quote, and the caller needs
  // to tell those apart the same way the old single-venue code did (via a
  // thrown error, caught below).
  if (candidates.length === 0) throw new Error("no venue could price this token");
  const best = candidates.reduce((a, b) => (b > a ? b : a));
  const rawValuePls = Number(formatEther(best));
  return vaultAddress ? netOfExitCostsPls(rawValuePls, vaultAddress) : rawValuePls;
}

// Decimals and symbol never change for a given token - cached per server
// process so pricing five open positions in the same token (or the same
// position re-priced on every poll) doesn't repeat two RPC calls it already
// has the answer to.
const tokenMetaCache = new Map();
async function getTokenMeta(token) {
  const key = token.toLowerCase();
  const cached = tokenMetaCache.get(key);
  if (cached) return cached;
  const erc = new Contract(token, ERC20_ABI, getProvider());
  const meta = await Promise.all([
    withTimeout(erc.decimals(), 8000).catch(() => 18),
    withTimeout(erc.symbol(), 8000).catch(() => "???"),
  ]).then(([decimals, symbol]) => ({ decimals, symbol }));
  tokenMetaCache.set(key, meta);
  return meta;
}

/**
 * Adds just the symbol to a set of positions that don't need live pricing -
 * closed and rugged/stuck ones. They're done trading (or, for a rugged one,
 * never going to sell), so there's no valueNowPls/pnlPct to compute, but the
 * dashboard still needs to say what token each row actually was - a bare
 * truncated address doesn't tell an owner what they're looking at or
 * withdrawing. Same getTokenMeta cache as priceOpenPositions, throttled the
 * same way so a vault with many closed positions doesn't reintroduce the
 * concurrent-RPC-burst problem that caused false "no liquidity" readings.
 */
async function attachSymbols(positions) {
  return mapLimit(positions, RPC_CONCURRENCY, async (p) => {
    try {
      const meta = await getTokenMeta(p.token);
      return { ...p, symbol: meta.symbol };
    } catch {
      return { ...p, symbol: null };
    }
  });
}

/**
 * Adds live valueNowPls/pnlPct to each open position (field names kept as-is
 * for shape-compatibility with the keeper's history schema - the values are
 * in whichever base unit this chain uses), plus tokensHeld/symbol - the
 * actual quantity held, decimals-correct, not just what was spent to get it.
 * Knowing you spent 900 PLS doesn't tell you what you're holding; knowing you
 * hold 1,204.5 INC does. A quote or metadata failure leaves those fields
 * null rather than throwing - one unpriceable token shouldn't blank out the
 * whole dashboard.
 */
async function priceOpenPositions(openPositions, vaultAddress) {
  return mapLimit(openPositions, RPC_CONCURRENCY, async (p) => {
    let valueNowPls = null;
    let pnlPct = null;
    let tokensHeld = null;
    let symbol = null;
    try {
      valueNowPls = await quotePlsValue(p.token, p.tokens_held, vaultAddress);
      pnlPct = p.spent_pls > 0 ? ((valueNowPls - p.spent_pls) / p.spent_pls) * 100 : null;
    } catch { /* leave valueNowPls/pnlPct null */ }
    try {
      const meta = await getTokenMeta(p.token);
      tokensHeld = Number(formatUnits(BigInt(p.tokens_held), meta.decimals));
      symbol = meta.symbol;
    } catch { /* leave tokensHeld/symbol null */ }
    return { ...p, valueNowPls, pnlPct, tokensHeld, symbol };
  });
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
      try { valuePls = await quotePlsValue(token, balanceRaw.toString(), vaultAddress); } catch { /* leave null */ }
    }
    return { token: token.toLowerCase(), symbol, decimals, balance, valuePls };
  } catch {
    return { token: token.toLowerCase(), symbol: "???", decimals: 18, balance: null, valuePls: null };
  }
}

async function getPortfolio(vaultAddress, tokens) {
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase()))];
  return mapLimit(distinct, RPC_CONCURRENCY, (t) => getPortfolioToken(vaultAddress, t));
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

module.exports = { priceOpenPositions, attachSymbols, quotePlsValue, getPortfolio, getUnitPrice };
