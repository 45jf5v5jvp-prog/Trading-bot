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
export async function simulate(token: string): Promise<{
  sellable: boolean; buyTaxBps: number; sellTaxBps: number; roundTripLossBps: number;
} | null> {
  const probeAddr = process.env.PROBE_ADDRESS;
  if (!probeAddr) return null;

  const value = parseEther(String(CFG.simAmountPls));
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
export async function lpLockedPct(pair: string): Promise<number> {
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
export async function checkOwnerRenounced(token: string): Promise<boolean> {
  try {
    const t = new Contract(token, ERC20_ABI, provider) as Dyn;
    const owner: string = await t.owner();
    return /^0x0{40}$/i.test(owner);
  } catch {
    return true;
  }
}

/** PLS-side depth of the token's WPLS pair. */
async function liquidityPls(token: string): Promise<{ liq: number; pair: string }> {
  const pair: string = await factory.getPair(token, CFG.wpls);
  if (/^0x0{40}$/i.test(pair)) return { liq: 0, pair: "" };
  const p = new Contract(pair, PAIR_ABI, provider) as Dyn;
  const [r0, r1] = await p.getReserves();
  const t0: string = await p.token0();
  const plsSide = t0.toLowerCase() === CFG.wpls.toLowerCase() ? r0 : r1;
  return { liq: Number(formatEther(BigInt(plsSide))), pair };
}

export async function screen(
  token: string,
  deployer: string | null,
  limits: ScreenLimits,
): Promise<Screen> {
  const out: Screen = {
    token, sellable: false, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 0,
    lpLockedPct: 0, deployerPct: 100, liqPls: 0, ownerRenounced: true, verdict: "fail", reason: "",
  };

  const { liq, pair } = await liquidityPls(token);
  out.liqPls = liq;
  if (!pair) return { ...out, reason: "no WPLS pair" };
  if (liq < limits.minLiquidityPls)
    return { ...out, reason: `liquidity ${Math.round(liq)} below floor ${limits.minLiquidityPls}` };

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
  // 80%, not 100% - the owner's own call: below this, a deployer can still
  // walk away with a meaningfully large, directly-extractable share of the
  // pool's paired-asset value on top of gutting its depth, so this isn't
  // loose, but 95%+ was screening out legitimate tokens that keep a small
  // working slice unlocked. Same threshold everywhere "require LP lock" is
  // checked - hunter.ts, discovery.ts (x2), launch.ts - keep them in sync.
  if (limits.requireLpLock && out.lpLockedPct < 80)
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
