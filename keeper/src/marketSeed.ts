import { Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { PAIR_ABI } from "./abis.js";
import { watched } from "./db.js";
import { ensureWatched } from "./prices.js";
import { plsUsd } from "./plsPrice.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Hunter and Discovery Bot only ever see tokens already in the `watched`
 * table (see prices.ts's ensureWatched), which until this existed only grew
 * from brand-new PulseX pairs (launch.ts), plus whatever a user individually
 * pointed a rule/snipe/Ask Icaria question at. Established, currently-liquid
 * tokens that launched before the keeper started watching - HEX, INC, PLSX,
 * whatever's actually trading - never made it in.
 *
 * This walks PulseX's entire pair list once per pass and adds every WPLS
 * pair above a $ liquidity floor, so both bots' candidate pool becomes the
 * whole tradeable market instead of only recent launches. It runs
 * periodically, not just once, because a token's liquidity can cross the
 * floor well after it first launched.
 *
 * Read-only and idempotent - ensureWatched no-ops for anything already
 * watched, so a repeat pass costs one cheap on-chain read per still-unwatched
 * pair and nothing at all for pairs it's already added.
 */

async function pairLiquidityUsd(pairAddr: string, usdPerPls: number): Promise<{ liqUsd: number; token: string } | null> {
  try {
    const p = new Contract(pairAddr, PAIR_ABI, provider) as Dyn;
    const [t0, t1, reserves] = await Promise.all([p.token0(), p.token1(), p.getReserves()]);
    const wpls = CFG.wpls.toLowerCase();
    const t0l = (t0 as string).toLowerCase();
    const t1l = (t1 as string).toLowerCase();
    if (t0l !== wpls && t1l !== wpls) return null; // not a WPLS pair at all
    const plsFirst = t0l === wpls;
    const plsRes = BigInt(plsFirst ? reserves[0] : reserves[1]);
    if (plsRes === 0n) return null;
    const pls = Number(formatEther(plsRes));
    // A constant-product pool holds equal USD value on both sides, so total
    // pool value is roughly double the WPLS-side reserve alone - close
    // enough for a screening floor, not a trade-sizing number.
    const liqUsd = pls * 2 * usdPerPls;
    const token = plsFirst ? t1l : t0l;
    return { liqUsd, token };
  } catch {
    return null;
  }
}

export async function seedMarket(): Promise<void> {
  const total = Number(await factory.allPairsLength());
  if (total === 0) return;

  const usdPerPls = await plsUsd();
  const floor = CFG.minSeedLiquidityUsd;
  log("info", "marketSeed", `Scanning ${total} PulseX pairs for WPLS pairs >= $${floor.toLocaleString()} liquidity (PLS/USD ~$${usdPerPls})`);

  const alreadyWatched = new Set(watched.all().map((w) => w.token));
  const indices = Array.from({ length: total }, (_, i) => i);

  let checked = 0;
  let added = 0;
  await mapLimit(indices, CFG.keeperConcurrency, async (i) => {
    try {
      const pairAddr: string = await factory.allPairs(i);
      const info = await pairLiquidityUsd(pairAddr, usdPerPls);
      checked++;
      if (checked % 2000 === 0) log("debug", "marketSeed", `Checked ${checked}/${total} pairs, ${added} added so far`);
      if (!info) return;
      if (alreadyWatched.has(info.token)) return;
      if (info.liqUsd < floor) return;
      if (await ensureWatched(info.token)) added++;
    } catch {
      // one bad pair index shouldn't stop the sweep
    }
  });

  log("info", "marketSeed", `Market seed pass done: checked ${checked}/${total} pairs, added ${added} new tokens above $${floor.toLocaleString()} liquidity`);
}
