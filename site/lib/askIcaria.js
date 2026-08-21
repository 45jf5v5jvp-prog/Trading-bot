const { JsonRpcProvider, Contract, Interface, formatEther, parseEther, toBeHex } = require("ethers");
const { CHAIN } = require("./chain");
const { getRecentPrices } = require("./keeperDb");
const { toCandles, snapshot } = require("./indicators");

/**
 * Ask Icaria: answers a free-form question about ANY token address the user
 * types in, not just ones a bot already flagged - "say you're looking to
 * make a trade, is this a good move." Runs the exact same mechanical checks
 * every bot in this codebase runs before it ever calls the AI (honeypot/tax
 * simulation via SwapProbe, LP-lock %, owner-renounced), then hands that
 * profile to Claude for a plain-English read. The AI never substitutes for
 * the mechanical checks - if the honeypot simulation is unavailable or the
 * token can't be sold, that's reported directly, no AI opinion needed.
 *
 * PulseChain-only for now, same as Hunter Bot - CHAIN.factory is empty on a
 * deployment (Robinhood) that hasn't verified one, and this fails clearly
 * rather than guessing an address.
 */

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function owner() view returns (address)",
];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const PROBE_ABI = [
  "function probe(address token) payable returns (tuple(bool buyOk,bool sellOk,uint256 quotedOut,uint256 actualOut,uint256 plsReturned,uint256 buyTaxBps,uint256 sellTaxBps,uint256 roundTripLossBps))",
];

// Same burn addresses as the keeper's BURN_ADDRESSES (keeper/src/config.ts) -
// duplicated rather than shared across the TS/JS boundary, kept identical on
// purpose.
const BURN_ADDRESSES = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
];

const SIM_ADDRESS = process.env.SIM_ADDRESS || "0x1111111111111111111111111111111111111111";
const SIM_AMOUNT_PLS = process.env.SIM_AMOUNT_PLS || "100000";
const PROBE_ADDRESS = process.env.PROBE_ADDRESS || "";
const HONEYPOT_MAX_LOSS_BPS = Number(process.env.HONEYPOT_MAX_LOSS_BPS || "1200");

let providerSingleton;
function getProvider() {
  if (!providerSingleton) providerSingleton = new JsonRpcProvider(CHAIN.rpcUrl, CHAIN.chainId, { staticNetwork: true });
  return providerSingleton;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC call timed out after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function simulate(token) {
  if (!PROBE_ADDRESS) return null;
  const iface = new Interface(PROBE_ABI);
  const value = parseEther(SIM_AMOUNT_PLS);
  const data = iface.encodeFunctionData("probe", [token]);
  try {
    const raw = await withTimeout(
      getProvider().send("eth_call", [
        { from: SIM_ADDRESS, to: PROBE_ADDRESS, value: toBeHex(value), data },
        "latest",
        { [SIM_ADDRESS]: { balance: toBeHex(value * 2n) } },
      ]),
      12000,
    );
    const [r] = iface.decodeFunctionResult("probe", raw);
    return {
      sellable: Boolean(r.buyOk) && Boolean(r.sellOk) && r.plsReturned > 0n,
      buyTaxBps: Number(r.buyTaxBps),
      sellTaxBps: Number(r.sellTaxBps),
      roundTripLossBps: Number(r.roundTripLossBps),
    };
  } catch {
    return null;
  }
}

async function lpLockedPct(pair) {
  const provider = getProvider();
  const p = new Contract(pair, PAIR_ABI, provider);
  const total = await p.totalSupply();
  if (total === 0n) return 0;
  let locked = 0n;
  for (const holder of BURN_ADDRESSES) {
    try { locked += await p.balanceOf(holder); } catch { /* skip */ }
  }
  return Number((locked * 10000n) / total) / 100;
}

async function ownerRenounced(token) {
  try {
    const t = new Contract(token, ERC20_ABI, getProvider());
    const owner = await t.owner();
    return /^0x0{40}$/i.test(owner);
  } catch {
    return true; // no owner()/reverts - permissive/unknown, same convention as the keeper's screener
  }
}

async function liquidityPls(token) {
  if (!CHAIN.factory) return { liq: 0, pair: "" };
  const provider = getProvider();
  const factory = new Contract(CHAIN.factory, FACTORY_ABI, provider);
  const pair = await factory.getPair(token, CHAIN.wrapped);
  if (/^0x0{40}$/i.test(pair)) return { liq: 0, pair: "" };
  const p = new Contract(pair, PAIR_ABI, provider);
  const [r0, r1] = await p.getReserves();
  const t0 = await p.token0();
  const plsSide = t0.toLowerCase() === CHAIN.wrapped.toLowerCase() ? r0 : r1;
  return { liq: Number(formatEther(plsSide)), pair };
}

// Same candle bucket size Hunter Bot detects on (keeper/src/hunter.ts's
// CANDLE_MINUTES), and a wide enough lookback for a real RSI/MACD/Bollinger/
// ATR read - the same window keeper/src/hunter.ts's LOOKBACK_HOURS uses.
const CANDLE_MINUTES = 15;
const TECHNICAL_LOOKBACK_HOURS = 48;

function priceMovePct(rows, sinceTs) {
  const inWindow = rows.filter((r) => r.ts >= sinceTs);
  if (inWindow.length < 2) return null;
  const first = inWindow[0].price;
  const last = inWindow[inWindow.length - 1].price;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

/**
 * Price action and technicals from the keeper's own price history (see
 * keeperDb.js's getRecentPrices) - this is what was missing before: Ask
 * Icaria could describe a token's tax/LP/renounce facts but had nothing to
 * say about what the price is actually doing or whether a technical setup
 * looks good, which is usually exactly what someone asking "is this a good
 * buy right now" wants to know. All fields null (not zero, not omitted) if
 * the keeper has no price history for this token yet - a token nobody has
 * watched long enough to have a real read on, not a token with a flat price.
 */
function buildTechnicalProfile(token, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const rows = getRecentPrices(token, nowSec - TECHNICAL_LOOKBACK_HOURS * 3600);
  if (rows.length === 0) {
    return {
      priceNow: null, priceMove1hPct: null, priceMove24hPct: null,
      rsi: null, macdHistogram: null, macdBullishCross: null, bollingerPercentB: null,
      atrPct: null, volRatio: null, historyHours: 0,
    };
  }
  const candles = toCandles(rows, CANDLE_MINUTES * 60);
  const snap = snapshot(candles);
  return {
    priceNow: rows[rows.length - 1].price,
    priceMove1hPct: priceMovePct(rows, nowSec - 3600),
    priceMove24hPct: priceMovePct(rows, nowSec - 86400),
    rsi: snap?.rsi ?? null,
    macdHistogram: snap?.macd?.histogram ?? null,
    macdBullishCross: snap?.macd?.bullishCross ?? null,
    bollingerPercentB: snap?.bollinger?.percentB ?? null,
    atrPct: snap?.atrPct ?? null,
    volRatio: snap?.volRatio ?? null,
    historyHours: (rows[rows.length - 1].ts - rows[0].ts) / 3600,
  };
}

/**
 * Builds the full mechanical profile for a token address, no AI involved.
 * Returns { error } instead of throwing when the token can't be evaluated
 * at all (no pair, no probe configured) - that's itself a direct, useful
 * answer ("this isn't even tradeable here"), not a failure to hide.
 */
async function buildProfile(token) {
  if (!CHAIN.factory)
    return { error: `Ask Icaria isn't wired up for ${CHAIN.chainName} yet - no V2 factory address configured.` };

  const { liq, pair } = await liquidityPls(token);
  if (!pair) return { error: `No ${CHAIN.dexName} pair found for this address against ${CHAIN.nativeSymbol}.` };

  const t = new Contract(token, ERC20_ABI, getProvider());
  const symbol = await t.symbol().catch(() => "???");
  const decimals = await t.decimals().catch(() => 18);

  const sim = await simulate(token);
  if (!sim) return { error: "Honeypot/tax simulation is unavailable right now (no probe configured, or the call failed) - refusing to guess." };

  const [lpPct, renounced] = await Promise.all([lpLockedPct(pair), ownerRenounced(token)]);

  return {
    symbol, token, pair, liqPls: liq, decimals: Number(decimals),
    sellable: sim.sellable, buyTaxBps: sim.buyTaxBps, sellTaxBps: sim.sellTaxBps,
    roundTripLossBps: sim.roundTripLossBps, honeypotLikely: sim.roundTripLossBps > HONEYPOT_MAX_LOSS_BPS || !sim.sellable,
    lpLockedPct: lpPct, ownerRenounced: renounced,
    ...buildTechnicalProfile(token),
  };
}

module.exports = { buildProfile, getProvider, buildTechnicalProfile, priceMovePct };
