import { Contract, Interface, formatEther, parseEther, toBeHex } from "ethers";
import { CFG, BURN_ADDRESSES, KNOWN_LOCKERS } from "./config.js";
import { provider, routerRead, factory, type Dyn } from "./chain.js";
import { ERC20_ABI, PAIR_ABI } from "./abis.js";
import { db } from "./db.js";
import { log } from "./log.js";

const PROBE_ABI = [
  "function probe(address token) payable returns (tuple(bool buyOk,bool sellOk,uint256 quotedOut,uint256 actualOut,uint256 plsReturned,uint256 buyTaxBps,uint256 sellTaxBps,uint256 roundTripLossBps))",
];
const probeIface = new Interface(PROBE_ABI);

export interface Screen {
  token: string;
  sellable: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  roundTripLossBps: number;
  lpLockedPct: number;
  deployerPct: number;
  liqPls: number;
  verdict: "pass" | "fail";
  reason: string;
}

export interface ScreenLimits {
  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  maxDeployerPct: number;
  minLiquidityPls: number;
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
    lpLockedPct: 0, deployerPct: 100, liqPls: 0, verdict: "fail", reason: "",
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
