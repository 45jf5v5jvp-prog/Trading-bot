import { Contract, Interface, formatEther, parseEther, toBeHex } from "ethers";
import { CFG, BURN_ADDRESSES, KNOWN_LOCKERS } from "./config.js";
import { provider, routerRead, factory, type Dyn } from "./chain.js";
import { ERC20_ABI, PAIR_ABI, V3_FACTORY_ABI, V3_QUOTER_ABI } from "./abis.js";
import { v4Quote, isBaseCurrency, type V4PoolKey } from "./venues.js";
import { db } from "./db.js";
import { log } from "./log.js";

const PROBE_ABI = [
  "function probe(address token) payable returns (tuple(bool buyOk,bool sellOk,uint256 quotedOut,uint256 actualOut,uint256 plsReturned,uint256 buyTaxBps,uint256 sellTaxBps,uint256 roundTripLossBps))",
];
const probeIface = new Interface(PROBE_ABI);

const PROBE_V3_ABI = [
  "function probe(address token, uint24 fee) payable returns (tuple(bool buyOk,bool sellOk,uint256 actualOut,uint256 ethReturned,uint256 roundTripLossBps))",
];
const probeV3Iface = new Interface(PROBE_V3_ABI);

const PROBE_V4_ABI = [
  "function probe((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) payable returns (tuple(bool buyOk,bool sellOk,uint256 actualOut,uint256 ethReturned,uint256 roundTripLossBps))",
];
const probeV4Iface = new Interface(PROBE_V4_ABI);

export interface Screen {
  token: string;
  sellable: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  roundTripLossBps: number;
  lpLockedPct: number;
  deployerPct: number;
  liqPls: number;
  ownerRenounced: boolean;
  verdict: "pass" | "fail";
  reason: string;
}

export interface ScreenLimits {
  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  maxDeployerPct: number;
  minLiquidityPls: number;
  requireOwnerRenounced: boolean;
}

/**
 * Runs the buy-and-sell simulation through SwapProbe.
 *
 * Read this before trusting the result: the simulation reflects the contract's
 * behaviour AT THIS BLOCK. A token with an owner-settable tax, a trading
 * enable/disable flag, or a blacklist can pass here and turn hostile in the
 * next block. Screening reduces the failure rate. It does not make sniping safe.
 */
async function simulate(token: string): Promise<{
  sellable: boolean; buyTaxBps: number; sellTaxBps: number; roundTripLossBps: number;
} | null> {
  const probeAddr = process.env.PROBE_ADDRESS;
  if (!probeAddr) return null;

  const value = parseEther(String(CFG.simAmountEth));
  const data = probeIface.encodeFunctionData("probe", [token]);

  try {
    const raw: string = await provider.send("eth_call", [
      { from: CFG.simAddress, to: probeAddr, value: toBeHex(value), data },
      "latest",
      { [CFG.simAddress]: { balance: toBeHex(value * 2n) } },
    ]);
    const [r] = probeIface.decodeFunctionResult("probe", raw);
    return {
      sellable: Boolean(r.buyOk) && Boolean(r.sellOk) && r.plsReturned > 0n,
      buyTaxBps: Number(r.buyTaxBps),
      sellTaxBps: Number(r.sellTaxBps),
      roundTripLossBps: Number(r.roundTripLossBps),
    };
  } catch (e) {
    log("warn", "screen", `Simulation failed for ${token}: ${(e as Error).message}`);
    return null;
  }
}

/** V3 equivalent of simulate() above - same reasoning, uses SwapProbeV3
 * against the specific fee-tier pool instead of SwapProbe against the V2 pair.
 * No buyTaxBps/sellTaxBps here - see SwapProbeV3.sol's top comment for why. */
async function simulateV3(token: string, fee: number): Promise<{
  sellable: boolean; roundTripLossBps: number;
} | null> {
  const probeAddr = CFG.probeAddressV3;
  if (!probeAddr) return null;

  const value = parseEther(String(CFG.simAmountEth));
  const data = probeV3Iface.encodeFunctionData("probe", [token, fee]);

  try {
    const raw: string = await provider.send("eth_call", [
      { from: CFG.simAddress, to: probeAddr, value: toBeHex(value), data },
      "latest",
      { [CFG.simAddress]: { balance: toBeHex(value * 2n) } },
    ]);
    const [r] = probeV3Iface.decodeFunctionResult("probe", raw);
    return {
      sellable: Boolean(r.buyOk) && Boolean(r.sellOk) && r.ethReturned > 0n,
      roundTripLossBps: Number(r.roundTripLossBps),
    };
  } catch (e) {
    log("warn", "screen", `V3 simulation failed for ${token} fee=${fee}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Stopgap liquidity signal for a V3 pool - see config.ts's v3MaxPriceImpactBps
 * comment for why this exists instead of a reserves-based floor. Compares the
 * per-ETH rate at a negligible trade size against the per-ETH rate at the
 * real trade size; a big gap means the pool is thin relative to this trade.
 */
async function v3PriceImpactBps(token: string, fee: number, tradeSizeEth: number): Promise<number | null> {
  if (!CFG.quoterV3) return null;
  const quoter = new Contract(CFG.quoterV3, V3_QUOTER_ABI, provider) as Dyn;
  const tiny = parseEther("0.0001");
  const real = parseEther(String(Math.max(tradeSizeEth, 0.0001)));
  try {
    const tinyResult = await quoter.quoteExactInputSingle.staticCall(CFG.weth, token, fee, tiny, 0);
    const realResult = await quoter.quoteExactInputSingle.staticCall(CFG.weth, token, fee, real, 0);
    const tinyOut: bigint = tinyResult[0];
    const realOut: bigint = realResult[0];
    if (tinyOut === 0n) return null;
    const tinyRate = Number(tinyOut) / Number(tiny);
    const realRate = Number(realOut) / Number(real);
    if (tinyRate === 0) return null;
    const impact = (tinyRate - realRate) / tinyRate;
    return Math.max(0, Math.round(impact * 10_000));
  } catch (e) {
    log("debug", "screen", `V3 price-impact check failed for ${token} fee=${fee}: ${(e as Error).message}`);
    return null;
  }
}

/** Share of LP tokens that are burned or sitting in a known locker. */
async function lpLockedPct(pair: string): Promise<number> {
  const p = new Contract(pair, PAIR_ABI, provider) as Dyn;
  const total: bigint = await p.totalSupply();
  if (total === 0n) return 0;
  let locked = 0n;
  for (const holder of [...BURN_ADDRESSES, ...KNOWN_LOCKERS]) {
    try { locked += BigInt(await p.balanceOf(holder)); } catch { /* skip */ }
  }
  return Number((locked * 10_000n) / total) / 100;
}

/** Share of total supply still sitting with whoever created the pair. */
async function deployerPct(token: string, deployer: string | null): Promise<number> {
  if (!deployer) return 100;
  try {
    const t = new Contract(token, ERC20_ABI, provider) as Dyn;
    const total: bigint = await t.totalSupply();
    if (total === 0n) return 100;
    const bal: bigint = await t.balanceOf(deployer);
    return Number((bal * 10_000n) / total) / 100;
  } catch {
    return 100;
  }
}

/**
 * Binary search for the earliest block at which `token` has contract code,
 * searching no later than `atOrBeforeBlock` (the block the pair was created
 * in - the token obviously already existed by then, so it's a safe upper
 * bound and keeps this to ~log2(atOrBeforeBlock) calls instead of walking
 * block-by-block).
 *
 * Assumes code, once deployed, stays deployed (no selfdestruct-then-redeploy
 * at the same address) - true for the overwhelming majority of ERC20s, and a
 * false negative here just means treating a redeployed address as "new,"
 * which is the conservative direction to be wrong in for a launch sniper.
 */
async function findDeployBlock(token: string, atOrBeforeBlock: number): Promise<number> {
  let lo = 0;
  let hi = atOrBeforeBlock;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(token, mid);
    if (code === "0x") lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * True if the token has renounced ownership (owner() returns the zero
 * address) - meaning whatever privileged/admin functions the contract has
 * can no longer be called by anyone. A retained, unrenounced owner is the
 * single most common way a token keeps a backdoor to blacklist or drain a
 * holder's balance well after a normal buy/sell simulation already passed -
 * exactly the failure mode this project hit for real. Not every safe token
 * uses the Ownable pattern at all, so a call that reverts (no owner()
 * function) is treated as permissive/unknown rather than blocked - this
 * check only bites tokens that DO have an owner and have not given it up.
 */
async function checkOwnerRenounced(token: string): Promise<boolean> {
  try {
    const t = new Contract(token, ERC20_ABI, provider) as Dyn;
    const owner: string = await t.owner();
    return /^0x0{40}$/i.test(owner);
  } catch {
    return true;
  }
}

/** PLS-side depth of the token's WETH pair. */
async function liquidityPls(token: string): Promise<{ liq: number; pair: string }> {
  const pair: string = await factory.getPair(token, CFG.weth);
  if (/^0x0{40}$/i.test(pair)) return { liq: 0, pair: "" };
  const p = new Contract(pair, PAIR_ABI, provider) as Dyn;
  const [r0, r1] = await p.getReserves();
  const t0: string = await p.token0();
  const plsSide = t0.toLowerCase() === CFG.weth.toLowerCase() ? r0 : r1;
  return { liq: Number(formatEther(BigInt(plsSide))), pair };
}

export async function screen(
  token: string,
  deployer: string | null,
  limits: ScreenLimits,
  pairBlockNumber: number,
): Promise<Screen> {
  const out: Screen = {
    token, sellable: false, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 0,
    lpLockedPct: 0, deployerPct: 100, liqPls: 0, ownerRenounced: true, verdict: "fail", reason: "",
  };

  const { liq, pair } = await liquidityPls(token);
  out.liqPls = liq;
  if (!pair) return { ...out, reason: "no WETH pair" };
  if (liq < limits.minLiquidityPls)
    return { ...out, reason: `liquidity ${Math.round(liq)} below floor ${limits.minLiquidityPls}` };

  // Before the expensive probe simulation: is this token actually new, or an
  // old one that just got a fresh WETH pairing? Checked here, ahead of
  // simulate(), so an old token gets rejected without spending a probe call on it.
  const deployBlock = await findDeployBlock(token, pairBlockNumber);
  const ageBlocks = pairBlockNumber - deployBlock;
  if (ageBlocks > CFG.maxTokenAgeBlocks)
    return { ...out, reason: `token contract is ${ageBlocks} blocks old - existed before this pairing, not a fresh launch` };

  const sim = await simulate(token);
  if (!sim) return { ...out, reason: "simulation unavailable, refusing to guess" };
  out.sellable = sim.sellable;
  out.buyTaxBps = sim.buyTaxBps;
  out.sellTaxBps = sim.sellTaxBps;
  out.roundTripLossBps = sim.roundTripLossBps;

  if (!sim.sellable) return { ...out, reason: "cannot sell after buying" };
  if (sim.roundTripLossBps > CFG.honeypotMaxLossBps)
    return { ...out, reason: `round trip loses ${sim.roundTripLossBps} bps` };
  if (sim.buyTaxBps > limits.maxBuyTaxBps)
    return { ...out, reason: `buy tax ${(sim.buyTaxBps / 100).toFixed(1)}% over limit` };
  if (sim.sellTaxBps > limits.maxSellTaxBps)
    return { ...out, reason: `sell tax ${(sim.sellTaxBps / 100).toFixed(1)}% over limit` };

  out.lpLockedPct = await lpLockedPct(pair);
  if (limits.requireLpLock && out.lpLockedPct < 95)
    return { ...out, reason: `only ${out.lpLockedPct.toFixed(1)}% of LP is locked or burned` };

  out.deployerPct = await deployerPct(token, deployer);
  if (out.deployerPct > limits.maxDeployerPct)
    return { ...out, reason: `deployer holds ${out.deployerPct.toFixed(1)}% of supply` };

  out.ownerRenounced = await checkOwnerRenounced(token);
  if (limits.requireOwnerRenounced && !out.ownerRenounced)
    return { ...out, reason: "owner has not renounced control of the contract" };

  out.verdict = "pass";
  out.reason = "clear";
  return out;
}

/**
 * V3 equivalent of screen() above. Same limits shape, same overall flow
 * (liquidity floor -> token age -> honeypot sim -> tax/loss checks ->
 * LP lock -> deployer share), with two real differences from the V2 path:
 *
 *   - Liquidity is a price-impact check (see v3PriceImpactBps), not a
 *     reserves floor - there's no reserves number on V3 to floor against.
 *   - LP lock can never pass. V3 liquidity positions are NFTs (via
 *     PositionManager), not the simple fungible LP-token balance V2's
 *     lpLockedPct checks. That detection isn't built yet, and silently
 *     treating "unverifiable" as "unlocked" (reject) is the safe direction
 *     to be wrong in - the alternative is silently treating it as "locked,"
 *     which would be a real, invisible regression from what V2 screening
 *     actually guarantees today.
 */
export async function screenV3(
  token: string,
  deployer: string | null,
  limits: ScreenLimits,
  fee: number,
  poolBlockNumber: number,
): Promise<Screen> {
  const out: Screen = {
    token, sellable: false, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 0,
    lpLockedPct: 0, deployerPct: 100, liqPls: 0, ownerRenounced: true, verdict: "fail", reason: "",
  };

  if (!CFG.factoryV3 || !CFG.routerV3) return { ...out, reason: "V3 not configured" };

  const v3Factory = new Contract(CFG.factoryV3, V3_FACTORY_ABI, provider) as Dyn;
  const pool: string = await v3Factory.getPool(token, CFG.weth, fee);
  if (/^0x0{40}$/i.test(pool)) return { ...out, reason: "no V3 pool at this fee tier" };

  const impactBps = await v3PriceImpactBps(token, fee, CFG.simAmountEth);
  if (impactBps === null) return { ...out, reason: "could not price this pool, refusing to guess" };
  if (impactBps > CFG.v3MaxPriceImpactBps)
    return { ...out, reason: `price impact ${impactBps}bps above floor ${CFG.v3MaxPriceImpactBps}bps - pool too thin` };

  const deployBlock = await findDeployBlock(token, poolBlockNumber);
  const ageBlocks = poolBlockNumber - deployBlock;
  if (ageBlocks > CFG.maxTokenAgeBlocks)
    return { ...out, reason: `token contract is ${ageBlocks} blocks old - existed before this pool, not a fresh launch` };

  const sim = await simulateV3(token, fee);
  if (!sim) return { ...out, reason: "V3 simulation unavailable, refusing to guess" };
  out.sellable = sim.sellable;
  out.roundTripLossBps = sim.roundTripLossBps;

  if (!sim.sellable) return { ...out, reason: "cannot sell after buying" };
  if (sim.roundTripLossBps > CFG.honeypotMaxLossBps)
    return { ...out, reason: `round trip loses ${sim.roundTripLossBps} bps` };

  if (limits.requireLpLock)
    return { ...out, reason: "LP lock cannot be verified for V3 pools yet - rejecting rather than assume it's fine" };

  out.deployerPct = await deployerPct(token, deployer);
  if (out.deployerPct > limits.maxDeployerPct)
    return { ...out, reason: `deployer holds ${out.deployerPct.toFixed(1)}% of supply` };

  out.ownerRenounced = await checkOwnerRenounced(token);
  if (limits.requireOwnerRenounced && !out.ownerRenounced)
    return { ...out, reason: "owner has not renounced control of the contract" };

  out.verdict = "pass";
  out.reason = "clear";
  return out;
}

/** V4 equivalent of simulateV3 - the probe runs a real buy+sell through the
 * pool (hook code included) under eth_call. See SwapProbeV4.sol. */
async function simulateV4(key: V4PoolKey): Promise<{
  sellable: boolean; roundTripLossBps: number;
} | null> {
  const probeAddr = CFG.probeAddressV4;
  if (!probeAddr) return null;

  const value = parseEther(String(CFG.simAmountEth));
  const data = probeV4Iface.encodeFunctionData("probe", [key]);

  try {
    const raw: string = await provider.send("eth_call", [
      { from: CFG.simAddress, to: probeAddr, value: toBeHex(value), data },
      "latest",
      { [CFG.simAddress]: { balance: toBeHex(value * 2n) } },
    ]);
    const [r] = probeV4Iface.decodeFunctionResult("probe", raw);
    return {
      sellable: Boolean(r.buyOk) && Boolean(r.sellOk) && r.ethReturned > 0n,
      roundTripLossBps: Number(r.roundTripLossBps),
    };
  } catch (e) {
    log("warn", "screen", `V4 simulation failed for pool hook=${key.hooks}: ${(e as Error).message}`);
    return null;
  }
}

/** Same thin-pool signal as v3PriceImpactBps, priced through the V4 probe. */
async function v4PriceImpactBps(key: V4PoolKey, tradeSizeEth: number): Promise<number | null> {
  const tiny = parseEther("0.0001");
  const real = parseEther(String(Math.max(tradeSizeEth, 0.0001)));
  const zeroForOne = isBaseCurrency(key.currency0); // buy direction: base in
  const tinyOut = await v4Quote(key, zeroForOne, tiny);
  const realOut = await v4Quote(key, zeroForOne, real);
  if (tinyOut === null || realOut === null || tinyOut === 0n) return null;
  const tinyRate = Number(tinyOut) / Number(tiny);
  const realRate = Number(realOut) / Number(real);
  if (tinyRate === 0) return null;
  const impact = (tinyRate - realRate) / tinyRate;
  return Math.max(0, Math.round(impact * 10_000));
}

/**
 * V4 screen. Same flow as screenV3 (thin-pool check -> token age ->
 * honeypot sim -> LP lock -> deployer share -> owner renounce), with the V4
 * particulars:
 *
 *   - The pool's hook runs inside every probe simulation, so a hook that
 *     taxes or blocks at screen time IS caught. A hook that changes
 *     behaviour later is not catchable at screen time - see
 *     MultiVenueVaultV4.sol's risk notes. Position sizing is the defence.
 *   - LP lock can never pass, same honest refusal as V3: V4 liquidity is
 *     position state inside the PoolManager, and lock detection for it
 *     isn't built. Require-LP-lock therefore blocks V4 buys.
 */
export async function screenV4(
  token: string,
  deployer: string | null,
  limits: ScreenLimits,
  key: V4PoolKey,
  poolBlockNumber: number,
): Promise<Screen> {
  const out: Screen = {
    token, sellable: false, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 0,
    lpLockedPct: 0, deployerPct: 100, liqPls: 0, ownerRenounced: true, verdict: "fail", reason: "",
  };

  if (!CFG.poolManager || !CFG.probeAddressV4) return { ...out, reason: "V4 not configured" };

  const impactBps = await v4PriceImpactBps(key, CFG.simAmountEth);
  if (impactBps === null) return { ...out, reason: "could not price this pool, refusing to guess" };
  if (impactBps > CFG.v4MaxPriceImpactBps)
    return { ...out, reason: `price impact ${impactBps}bps above floor ${CFG.v4MaxPriceImpactBps}bps - pool too thin` };

  const deployBlock = await findDeployBlock(token, poolBlockNumber);
  const ageBlocks = poolBlockNumber - deployBlock;
  if (ageBlocks > CFG.maxTokenAgeBlocks)
    return { ...out, reason: `token contract is ${ageBlocks} blocks old - existed before this pool, not a fresh launch` };

  const sim = await simulateV4(key);
  if (!sim) return { ...out, reason: "V4 simulation unavailable, refusing to guess" };
  out.sellable = sim.sellable;
  out.roundTripLossBps = sim.roundTripLossBps;

  if (!sim.sellable) return { ...out, reason: "cannot sell after buying" };
  if (sim.roundTripLossBps > CFG.honeypotMaxLossBps)
    return { ...out, reason: `round trip loses ${sim.roundTripLossBps} bps` };

  if (limits.requireLpLock)
    return { ...out, reason: "LP lock cannot be verified for V4 pools yet - rejecting rather than assume it's fine" };

  out.deployerPct = await deployerPct(token, deployer);
  if (out.deployerPct > limits.maxDeployerPct)
    return { ...out, reason: `deployer holds ${out.deployerPct.toFixed(1)}% of supply` };

  out.ownerRenounced = await checkOwnerRenounced(token);
  if (limits.requireOwnerRenounced && !out.ownerRenounced)
    return { ...out, reason: "owner has not renounced control of the contract" };

  out.verdict = "pass";
  out.reason = "clear";
  return out;
}

export function recordScreen(s: Screen): void {
  db.prepare(`INSERT OR REPLACE INTO screened
    (token,ts,sellable,loss_bps,buy_tax_bps,sell_tax_bps,lp_locked_pct,deployer_pct,liq_pls,verdict,reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    s.token.toLowerCase(), Math.floor(Date.now() / 1000), s.sellable ? 1 : 0,
    s.roundTripLossBps, s.buyTaxBps, s.sellTaxBps, s.lpLockedPct, s.deployerPct,
    s.liqPls, s.verdict, s.reason,
  );
}

export { routerRead };
