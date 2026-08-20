import { Contract, parseEther } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { V3_FACTORY_ABI, V3_QUOTER_ABI, ROUTER_ABI, V4_PROBE_ABI } from "./abis.js";
import { v4Pools, type V4PoolRow } from "./db.js";
import { log } from "./log.js";

/** The full V4 pool identity - what Initialize announced and what every
 * quote/swap against that pool must repeat verbatim. */
export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export type Venue =
  | { kind: "v2"; amountOut: bigint }
  | { kind: "v3"; fee: number; amountOut: bigint }
  | { kind: "v4"; key: V4PoolKey; amountOut: bigint };

const ZERO = "0x0000000000000000000000000000000000000000";

/** True for the currencies this bot can account in: WETH and native ETH. */
export function isBaseCurrency(c: string): boolean {
  const lc = c.toLowerCase();
  return lc === ZERO || lc === CFG.weth.toLowerCase();
}

function rowToKey(p: V4PoolRow): V4PoolKey {
  return { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tick_spacing, hooks: p.hooks };
}

/** Quote through this repo's own SwapProbeV4 - see that contract for why no
 * external V4 quoter deployment is needed. Null = pool can't serve it. */
export async function v4Quote(key: V4PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  if (!CFG.probeAddressV4) return null;
  const probe = new Contract(CFG.probeAddressV4, V4_PROBE_ABI, provider) as Dyn;
  try {
    const out: bigint = await probe.quote.staticCall(key, zeroForOne, amountIn);
    return out > 0n ? out : null;
  } catch { return null; }
}

/** All V4 venue candidates for trading `token` against base, quoted at size.
 * `sellingToken` picks the direction: false = spend base for token. */
async function v4Candidates(token: string, amountIn: bigint, sellingToken: boolean): Promise<Venue[]> {
  if (!CFG.poolManager || !CFG.probeAddressV4) return [];
  const out: Venue[] = [];
  for (const row of v4Pools.forToken(token)) {
    // The hook allowlist gates BUYS here too, not just discovery - pools
    // recorded before the allowlist was set (or via another pool of an
    // allowed token) must not become buyable through the retry path.
    // Sells are exempt on purpose: an exit from something already held
    // must never be blocked by a config change made afterwards.
    if (!sellingToken && CFG.v4HooksAllowlist.length && !CFG.v4HooksAllowlist.includes(row.hooks.toLowerCase())) continue;
    const key = rowToKey(row);
    // Direction: zeroForOne means currency0 in, currency1 out. Buying spends
    // the base currency; selling spends the token.
    const c0IsBase = isBaseCurrency(key.currency0);
    const zeroForOne = sellingToken ? !c0IsBase : c0IsBase;
    const amountOut = await v4Quote(key, zeroForOne, amountIn);
    if (amountOut !== null) out.push({ kind: "v4", key, amountOut });
  }
  return out;
}

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

  candidates.push(...await v4Candidates(token, amountIn, false));

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

  candidates.push(...await v4Candidates(token, tokenAmount, true));

  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.amountOut > best.amountOut ? c : best));
}
