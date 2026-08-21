import { Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { PAIR_ABI } from "./abis.js";
import { watched, meta, wplsPairs } from "./db.js";
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
 * This adds every WPLS pair above a $ liquidity floor into watched, so both
 * bots' candidate pool becomes the whole tradeable market instead of only
 * recent launches. It runs periodically, not just once, because a token's
 * liquidity can cross the floor well after it first launched.
 *
 * PulseX's factory pair list runs into the hundreds of thousands, most of it
 * dead/abandoned launches - re-walking all of it every pass would make this
 * a multi-hour job forever. A pair's token0/token1 never change once
 * created, so which side (if either) is WPLS is a permanent fact: it only
 * needs discovering once per pair index (see db.ts's wpls_pairs table and
 * meta's marketSeedClassifiedUpTo checkpoint). Every pass after the first
 * only re-checks LIQUIDITY on the much smaller already-known-WPLS set, plus
 * classifies whatever pair indices are new since the last pass.
 */

/** Only the reserve read - use once a pair is already known to be a WPLS pair. */
async function pairReserveUsd(pairAddr: string, plsFirst: boolean, usdPerPls: number): Promise<number | null> {
  try {
    const p = new Contract(pairAddr, PAIR_ABI, provider) as Dyn;
    const reserves = await p.getReserves();
    const plsRes = BigInt(plsFirst ? reserves[0] : reserves[1]);
    if (plsRes === 0n) return null;
    const pls = Number(formatEther(plsRes));
    // A constant-product pool holds equal USD value on both sides, so total
    // pool value is roughly double the WPLS-side reserve alone - close
    // enough for a screening floor, not a trade-sizing number.
    return pls * 2 * usdPerPls;
  } catch {
    return null;
  }
}

/** Full classification (token0/token1 + reserves) - only for a pair whose WPLS-ness isn't known yet. */
async function classifyPair(pairAddr: string, usdPerPls: number): Promise<{ liqUsd: number; token: string; plsFirst: boolean } | null> {
  try {
    const p = new Contract(pairAddr, PAIR_ABI, provider) as Dyn;
    const [t0, t1, reserves] = await Promise.all([p.token0(), p.token1(), p.getReserves()]);
    const wpls = CFG.wpls.toLowerCase();
    const t0l = (t0 as string).toLowerCase();
    const t1l = (t1 as string).toLowerCase();
    if (t0l !== wpls && t1l !== wpls) return null; // not a WPLS pair at all
    const plsFirst = t0l === wpls;
    const plsRes = BigInt(plsFirst ? reserves[0] : reserves[1]);
    const pls = Number(formatEther(plsRes));
    const liqUsd = pls * 2 * usdPerPls;
    const token = plsFirst ? t1l : t0l;
    return { liqUsd, token, plsFirst };
  } catch {
    return null;
  }
}

// A pair-index chunk fully classified before the checkpoint advances - see
// the loop below. Small enough that a keeper restart mid-sweep (a routine
// deploy, a crash) loses at most one chunk's worth of RPC calls, not the
// whole multi-hour sweep - the original version of this only checkpointed
// once at the very end, which meant restarting the keeper for an unrelated
// deploy while a sweep was still running silently threw away all of its
// progress and started the next attempt over from index 0.
const CLASSIFY_CHUNK_SIZE = 1000;

export async function seedMarket(): Promise<void> {
  const total = Number(await factory.allPairsLength());
  if (total === 0) return;

  const usdPerPls = await plsUsd();
  const floor = CFG.minSeedLiquidityUsd;
  const alreadyWatched = new Set(watched.all().map((w) => w.token));
  // "added" is only tokens newly put into watched this pass. "aboveFloor" is
  // the real answer to "how many tokens clear the $ liquidity bar right
  // now" - it also counts ones already watched from before, which "added"
  // deliberately skips re-adding.
  let added = 0;
  let aboveFloor = 0;

  // Re-check liquidity on every already-known WPLS pair - the only part of
  // a repeat pass that can actually change.
  const known = wplsPairs.all();
  if (known.length > 0) {
    await mapLimit(known, CFG.keeperConcurrency, async (row) => {
      const liqUsd = await pairReserveUsd(row.pair, row.plsFirst, usdPerPls);
      if (liqUsd === null || liqUsd < floor) return;
      aboveFloor++;
      if (alreadyWatched.has(row.token)) return;
      if (await ensureWatched(row.token)) added++;
    });
  }

  // Classify whatever pair indices are new since the last pass. New pairs
  // are already caught immediately by launch.ts - this is a completeness
  // backstop, and after the first run it's normally a small, fast increment.
  const classifiedUpTo0 = Number(meta.get("marketSeedClassifiedUpTo", "0"));
  if (classifiedUpTo0 < total) {
    const toClassify = total - classifiedUpTo0;
    log("info", "marketSeed", `Re-checked ${known.length} known WPLS pairs; classifying ${toClassify} new pair(s) (index ${classifiedUpTo0}..${total - 1}) for liquidity >= $${floor.toLocaleString()} (PLS/USD ~$${usdPerPls})`);
    let checked = 0;
    let newWplsPairs = 0;
    let chunkStart = classifiedUpTo0;
    while (chunkStart < total) {
      const chunkEnd = Math.min(chunkStart + CLASSIFY_CHUNK_SIZE, total);
      const indices = Array.from({ length: chunkEnd - chunkStart }, (_, k) => chunkStart + k);
      await mapLimit(indices, CFG.keeperConcurrency, async (i) => {
        try {
          const pairAddr: string = await factory.allPairs(i);
          const info = await classifyPair(pairAddr, usdPerPls);
          checked++;
          if (!info) return; // not a WPLS pair - never re-checked again
          wplsPairs.insert(i, pairAddr, info.token, info.plsFirst);
          newWplsPairs++;
          if (info.liqUsd < floor) return;
          aboveFloor++;
          if (alreadyWatched.has(info.token)) return;
          if (await ensureWatched(info.token)) added++;
        } catch {
          // One bad pair index (a transient RPC error, a malformed pair
          // contract) shouldn't stop the sweep. It's not retried - the
          // checkpoint advances past it below regardless - but a token
          // missed this way still gets caught by launch.ts if it's a new
          // pair, or by a rule/snipe/Ask Icaria lookup if a user points at
          // it directly.
        }
      });
      // Checkpoint after every chunk, not just once at the very end - see
      // CLASSIFY_CHUNK_SIZE's comment. Safe because mapLimit above only
      // returns once every index in this chunk has actually finished.
      meta.set("marketSeedClassifiedUpTo", String(chunkEnd));
      chunkStart = chunkEnd;
      log("debug", "marketSeed", `Classified ${checked}/${toClassify} new pairs, ${added} tokens added so far (checkpoint at index ${chunkEnd})`);
    }
    log("info", "marketSeed", `Market seed pass done: ${aboveFloor} of ${known.length + newWplsPairs} known WPLS pairs are above $${floor.toLocaleString()} liquidity (${added} newly added to watched this pass)`);
  } else {
    log("info", "marketSeed", `Re-checked ${known.length} known WPLS pairs; no new pairs since the last classification pass. ${aboveFloor} are above $${floor.toLocaleString()} liquidity (${added} newly added to watched this pass)`);
  }
}
