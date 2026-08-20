const { JsonRpcProvider, Contract, Interface, formatEther, parseEther, toBeHex } = require("ethers");
const { CHAIN } = require("./chain");
const { getV4PoolsForToken } = require("./keeperDb");

/**
 * Ask Icaria: answers a free-form question about ANY token address the user
 * types in - "say you're looking to make a trade, is this a good move."
 * Runs the exact same mechanical checks every bot in this codebase runs
 * before it ever calls the AI (honeypot/tax simulation via a SwapProbe, LP-
 * lock %, owner-renounced), then hands that profile to Claude for a plain-
 * English read. The AI never substitutes for the mechanical checks - if the
 * honeypot simulation is unavailable or the token can't be sold, that's
 * reported directly, no AI opinion needed.
 *
 * Venue-aware across V2/V3/V4, unlike the PulseChain version of this file
 * (which stays V2-only, since PulseChain only has PulseX V2). This mirrors
 * the same tri-venue reach keeper/src/screener.ts already runs server-side
 * for Launch Bot screening (simulate/simulateV3/simulateV4) and the same
 * quote-detection site/lib/livePrice.js already runs for pricing open
 * positions (quoteV2/quoteV3/quoteV4) - Robinhood Chain has real V3 and V4
 * activity, so staying V2-only here would silently tell a user "not
 * tradeable" about a token that trades fine on V3 or V4. This is a
 * deliberate scope decision, not scope creep: venue-aware simulation
 * already exists elsewhere in this repo for the identical reason (Launch
 * Bot screening a token it has never seen before), so Ask Icaria mirrors
 * it rather than being the first thing to add V3/V4 support.
 *
 * Detection tries each venue in order - V2 first (the common case and the
 * only venue this repo can verify an LP lock % against), then V3, then V4 -
 * and uses whichever one actually has a market for this token. This is a
 * "does a market exist" check, not a "which venue prices best" one (unlike
 * venues.ts's findBestVenue, built for sizing a real trade) - Ask Icaria
 * only needs one valid path to run the honeypot simulation through.
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
const V3_FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];
const PROBE_ABI = [
  "function probe(address token) payable returns (tuple(bool buyOk,bool sellOk,uint256 quotedOut,uint256 actualOut,uint256 plsReturned,uint256 buyTaxBps,uint256 sellTaxBps,uint256 roundTripLossBps))",
];
const PROBE_V3_ABI = [
  "function probe(address token, uint24 fee) payable returns (tuple(bool buyOk,bool sellOk,uint256 actualOut,uint256 ethReturned,uint256 roundTripLossBps))",
];
const PROBE_V4_ABI = [
  "function probe((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) payable returns (tuple(bool buyOk,bool sellOk,uint256 actualOut,uint256 ethReturned,uint256 roundTripLossBps))",
];

// Same burn addresses as the keeper's BURN_ADDRESSES (keeper/src/config.ts) -
// duplicated rather than shared across the TS/JS boundary, kept identical on
// purpose.
const BURN_ADDRESSES = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
];

const SIM_ADDRESS = process.env.SIM_ADDRESS || "0x1111111111111111111111111111111111111111";
// PulseChain's native unit (PLS) trades at huge nominal amounts; this
// chain's (ETH) trades at tiny ones - same reasoning as keeper/src/
// config.ts's SIM_AMOUNT_ETH default (0.02) vs the PulseChain keeper's
// SIM_AMOUNT_PLS default (100000). Kept as SIM_AMOUNT_PLS for env-var
// shape-compatibility across both deployments; only the default differs.
const SIM_AMOUNT_PLS = process.env.SIM_AMOUNT_PLS || (CHAIN.key === "robinhood" ? "0.02" : "100000");
const PROBE_ADDRESS = process.env.PROBE_ADDRESS || "";
// V3/V4 probes - server-only env vars, same "no fabricated defaults"
// convention as PROBE_ADDRESS. V4 reuses CHAIN.probeAddressV4 (already
// established by livePrice.js's quoteV4) rather than a second env var.
const PROBE_ADDRESS_V3 = process.env.PROBE_ADDRESS_V3 || "";
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

async function simulateV2(token) {
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

/** V3 equivalent - same reasoning as keeper/src/screener.ts's simulateV3.
 * No buyTaxBps/sellTaxBps here, same as the keeper version - see
 * SwapProbeV3.sol's top comment for why. */
async function simulateV3(token, fee) {
  if (!PROBE_ADDRESS_V3) return null;
  const iface = new Interface(PROBE_V3_ABI);
  const value = parseEther(SIM_AMOUNT_PLS);
  const data = iface.encodeFunctionData("probe", [token, fee]);
  try {
    const raw = await withTimeout(
      getProvider().send("eth_call", [
        { from: SIM_ADDRESS, to: PROBE_ADDRESS_V3, value: toBeHex(value), data },
        "latest",
        { [SIM_ADDRESS]: { balance: toBeHex(value * 2n) } },
      ]),
      12000,
    );
    const [r] = iface.decodeFunctionResult("probe", raw);
    return {
      sellable: Boolean(r.buyOk) && Boolean(r.sellOk) && r.ethReturned > 0n,
      buyTaxBps: 0, sellTaxBps: 0,
      roundTripLossBps: Number(r.roundTripLossBps),
    };
  } catch {
    return null;
  }
}

/** V4 equivalent - same reasoning as keeper/src/screener.ts's simulateV4.
 * Runs through the same SwapProbeV4 deployment livePrice.js's quoteV4
 * already uses for pricing (CHAIN.probeAddressV4), just calling its
 * honeypot-simulation `probe` function instead of its `quote` function. */
async function simulateV4(key) {
  if (!CHAIN.probeAddressV4) return null;
  const iface = new Interface(PROBE_V4_ABI);
  const value = parseEther(SIM_AMOUNT_PLS);
  const data = iface.encodeFunctionData("probe", [key]);
  try {
    const raw = await withTimeout(
      getProvider().send("eth_call", [
        { from: SIM_ADDRESS, to: CHAIN.probeAddressV4, value: toBeHex(value), data },
        "latest",
        { [SIM_ADDRESS]: { balance: toBeHex(value * 2n) } },
      ]),
      12000,
    );
    const [r] = iface.decodeFunctionResult("probe", raw);
    return {
      sellable: Boolean(r.buyOk) && Boolean(r.sellOk) && r.ethReturned > 0n,
      buyTaxBps: 0, sellTaxBps: 0,
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

async function findV2Pair(token) {
  if (!CHAIN.factory) return null;
  const provider = getProvider();
  const factory = new Contract(CHAIN.factory, FACTORY_ABI, provider);
  const pair = await factory.getPair(token, CHAIN.wrapped);
  if (/^0x0{40}$/i.test(pair)) return null;
  const p = new Contract(pair, PAIR_ABI, provider);
  const [r0, r1] = await p.getReserves();
  const t0 = await p.token0();
  const plsSide = t0.toLowerCase() === CHAIN.wrapped.toLowerCase() ? r0 : r1;
  return { pair, liq: Number(formatEther(plsSide)) };
}

async function findV3Pool(token) {
  if (!CHAIN.factoryV3 || !CHAIN.quoterV3) return null;
  const provider = getProvider();
  const factory = new Contract(CHAIN.factoryV3, V3_FACTORY_ABI, provider);
  for (const fee of CHAIN.v3FeeTiers) {
    try {
      const pool = await factory.getPool(token, CHAIN.wrapped, fee);
      if (!/^0x0{40}$/i.test(pool)) return { pool, fee };
    } catch { /* try the next tier */ }
  }
  return null;
}

/** First V4 pool the keeper's own scanner has recorded for this token - see
 * lib/keeperDb.js's getV4PoolsForToken for why this reads the keeper's own
 * table rather than doing an on-chain lookup (V4 pools have no such lookup). */
function findV4Pool(token) {
  if (!CHAIN.poolManager || !CHAIN.probeAddressV4) return null;
  const rows = getV4PoolsForToken(token);
  return rows.length ? rows[0] : null;
}

/**
 * Builds the full mechanical profile for a token address, no AI involved.
 * Returns { error } instead of throwing when the token can't be evaluated
 * at all (no pool on any venue, no probe configured) - that's itself a
 * direct, useful answer ("this isn't even tradeable here"), not a failure
 * to hide.
 */
async function buildProfile(token) {
  const t = new Contract(token, ERC20_ABI, getProvider());
  const symbol = await t.symbol().catch(() => "???");

  const v2 = await findV2Pair(token);
  if (v2) {
    const sim = await simulateV2(token);
    if (!sim) return { error: "Honeypot/tax simulation is unavailable right now (no V2 probe configured, or the call failed) - refusing to guess." };
    const [lpPct, renounced] = await Promise.all([lpLockedPct(v2.pair), ownerRenounced(token)]);
    return {
      symbol, token, pair: v2.pair, liqPls: v2.liq, venue: "v2",
      sellable: sim.sellable, buyTaxBps: sim.buyTaxBps, sellTaxBps: sim.sellTaxBps,
      roundTripLossBps: sim.roundTripLossBps, honeypotLikely: sim.roundTripLossBps > HONEYPOT_MAX_LOSS_BPS || !sim.sellable,
      lpLockedPct: lpPct, lpLockUnverifiable: false, ownerRenounced: renounced,
    };
  }

  const v3 = await findV3Pool(token);
  if (v3) {
    const sim = await simulateV3(token, v3.fee);
    if (!sim) return { error: "Honeypot simulation is unavailable right now for this V3 pool (no V3 probe configured, or the call failed) - refusing to guess." };
    const renounced = await ownerRenounced(token);
    return {
      symbol, token, pair: v3.pool, liqPls: 0, venue: `v3 (fee ${v3.fee})`,
      sellable: sim.sellable, buyTaxBps: sim.buyTaxBps, sellTaxBps: sim.sellTaxBps,
      roundTripLossBps: sim.roundTripLossBps, honeypotLikely: sim.roundTripLossBps > HONEYPOT_MAX_LOSS_BPS || !sim.sellable,
      // V3 liquidity positions are NFTs, not a fungible LP-token balance -
      // there's no lock % to check, same honest refusal as the keeper's
      // own screenV3 (which rejects a requireLpLock buy for this reason).
      lpLockedPct: 0, lpLockUnverifiable: true, ownerRenounced: renounced,
    };
  }

  const v4 = findV4Pool(token);
  if (v4) {
    const key = { currency0: v4.currency0, currency1: v4.currency1, fee: v4.fee, tickSpacing: v4.tick_spacing, hooks: v4.hooks };
    const sim = await simulateV4(key);
    if (!sim) return { error: "Honeypot simulation is unavailable right now for this V4 pool (no V4 probe configured, or the call failed) - refusing to guess." };
    const renounced = await ownerRenounced(token);
    return {
      symbol, token, pair: "", liqPls: 0, venue: "v4",
      sellable: sim.sellable, buyTaxBps: sim.buyTaxBps, sellTaxBps: sim.sellTaxBps,
      roundTripLossBps: sim.roundTripLossBps, honeypotLikely: sim.roundTripLossBps > HONEYPOT_MAX_LOSS_BPS || !sim.sellable,
      // Same honest refusal as V3 above - V4 liquidity is PoolManager
      // position state, not a checkable LP-token balance.
      lpLockedPct: 0, lpLockUnverifiable: true, ownerRenounced: renounced,
    };
  }

  return { error: `No ${CHAIN.dexName} pool found for this address against ${CHAIN.nativeSymbol} on V2, V3, or V4.` };
}

module.exports = { buildProfile, getProvider };
