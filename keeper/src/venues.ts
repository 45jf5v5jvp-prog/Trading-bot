import { Contract, parseEther } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { V3_FACTORY_ABI, V3_QUOTER_ABI, ROUTER_ABI } from "./abis.js";
import { log } from "./log.js";

export type Venue =
  | { kind: "v2"; amountOut: bigint }
  | { kind: "v3"; fee: number; amountOut: bigint };

/**
 * Which venue actually gives the best price for THIS trade size, not which
 * one has the biggest raw liquidity number. A V3 pool can show a huge
 * `liquidity()` figure while still pricing worse than a smaller, better-
 * positioned V2 pair at the size you're actually trading - concentrated
 * liquidity only helps if it's concentrated where the current price sits.
 * Quoting every candidate at the real trade size and comparing tokens-out
 * head to head sidesteps that entirely: whichever answer is biggest wins,
 * full stop, regardless of what "liquidity" means on that particular venue.
 *
 * Returns null if no real pool exists anywhere for this token.
 */
export async function findBestVenue(token: string, tradeSizeEth: number): Promise<Venue | null> {
  const amountIn = parseEther(String(tradeSizeEth));
  const candidates: Venue[] = [];

  // V2: always checked, same as before this file existed.
  try {
    const pair: string = await factory.getPair(token, CFG.weth);
    if (!/^0x0{40}$/i.test(pair)) {
      const router = new Contract(CFG.router, ROUTER_ABI, provider) as Dyn;
      const amounts: bigint[] = await router.getAmountsOut(amountIn, [CFG.weth, token]);
      candidates.push({ kind: "v2", amountOut: amounts[amounts.length - 1]! });
    }
  } catch (e) {
    log("debug", "venues", `V2 quote failed for ${token}: ${(e as Error).message}`);
  }

  // V3: only if configured. Checks every configured fee tier that actually
  // has a pool deployed - a token can have several simultaneously.
  if (CFG.factoryV3 && CFG.quoterV3) {
    const v3Factory = new Contract(CFG.factoryV3, V3_FACTORY_ABI, provider) as Dyn;
    const quoter = new Contract(CFG.quoterV3, V3_QUOTER_ABI, provider) as Dyn;
    for (const fee of CFG.v3FeeTiers) {
      try {
        const pool: string = await v3Factory.getPool(token, CFG.weth, fee);
        if (/^0x0{40}$/i.test(pool)) continue;
        const result = await quoter.quoteExactInputSingle.staticCall(CFG.weth, token, fee, amountIn, 0);
        const amountOut: bigint = result[0];
        if (amountOut > 0n) candidates.push({ kind: "v3", fee, amountOut });
      } catch (e) {
        log("debug", "venues", `V3 fee=${fee} quote failed for ${token}: ${(e as Error).message}`);
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.amountOut > best.amountOut ? c : best));
}

/**
 * Sell-direction counterpart to findBestVenue - which venue gives the most
 * WETH back for selling `tokenAmount` of `token`, right now. Used by
 * positions.ts for both mark-to-market valuation and the actual exit, so a
 * position bought via V3 (which has no V2 pool at all) has a real, working
 * sell path instead of positions.ts's old hardcoded V2-only quote silently
 * failing and leaving the position stuck forever - the exact "buying works,
 * selling reverts" bug pattern this project has already hit three times.
 */
export async function findBestSellVenue(token: string, tokenAmount: bigint): Promise<Venue | null> {
  if (tokenAmount === 0n) return null;
  const candidates: Venue[] = [];

  try {
    const router = new Contract(CFG.router, ROUTER_ABI, provider) as Dyn;
    const amounts: bigint[] = await router.getAmountsOut(tokenAmount, [token, CFG.weth]);
    candidates.push({ kind: "v2", amountOut: amounts[amounts.length - 1]! });
  } catch (e) {
    log("debug", "venues", `V2 sell quote failed for ${token}: ${(e as Error).message}`);
  }

  if (CFG.factoryV3 && CFG.quoterV3) {
    const v3Factory = new Contract(CFG.factoryV3, V3_FACTORY_ABI, provider) as Dyn;
    const quoter = new Contract(CFG.quoterV3, V3_QUOTER_ABI, provider) as Dyn;
    for (const fee of CFG.v3FeeTiers) {
      try {
        const pool: string = await v3Factory.getPool(token, CFG.weth, fee);
        if (/^0x0{40}$/i.test(pool)) continue;
        const result = await quoter.quoteExactInputSingle.staticCall(token, CFG.weth, fee, tokenAmount, 0);
        const amountOut: bigint = result[0];
        if (amountOut > 0n) candidates.push({ kind: "v3", fee, amountOut });
      } catch (e) {
        log("debug", "venues", `V3 fee=${fee} sell quote failed for ${token}: ${(e as Error).message}`);
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.amountOut > best.amountOut ? c : best));
}
