import { Contract, Interface, formatUnits, formatEther, id } from "ethers";
import { CFG } from "./config.js";
import { provider, logsProvider, factory, type Dyn } from "./chain.js";
import { ERC20_ABI, PAIR_ABI } from "./abis.js";
import { prices, watched, meta, volumeAccum, tokenTraders } from "./db.js";
import { log } from "./log.js";

/**
 * PulseX stores no price history. Neither does PulseChain, in any form a rule
 * engine can query cheaply. So the keeper builds the series itself, one sample
 * at a time, and a token is only tradeable by rule once enough of it exists.
 *
 * This is the single most important asset the service accumulates. Back it up.
 */

export async function ensureWatched(token: string): Promise<boolean> {
  const t = token.toLowerCase();
  if (watched.all().some((w) => w.token === t)) return true;
  try {
    const pair: string = await factory.getPair(token, CFG.wpls);
    if (/^0x0{40}$/i.test(pair)) {
      log("warn", "prices", `No WPLS pair for ${token}, cannot watch`);
      return false;
    }
    const erc = new Contract(token, ERC20_ABI, provider) as Dyn;
    const p = new Contract(pair, PAIR_ABI, provider) as Dyn;
    const [sym, dec, t0] = await Promise.all([
      erc.symbol().catch(() => "???"),
      erc.decimals().catch(() => 18),
      p.token0(),
    ]);
    const plsFirst = (t0 as string).toLowerCase() === CFG.wpls.toLowerCase();
    watched.add(token, String(sym), Number(dec), pair, plsFirst);
    log("info", "prices", `Now watching ${sym} (${token})`);
    return true;
  } catch (e) {
    log("warn", "prices", `Cannot watch ${token}: ${(e as Error).message}`);
    return false;
  }
}

/** A watched row's WPLS-is-token0 flag, resolving and persisting it if this
 * row predates that column (see db.ts's watched.setPlsFirst). */
async function resolvePlsFirst(w: { token: string; pair: string; plsFirst: boolean | null }): Promise<boolean> {
  if (w.plsFirst !== null) return w.plsFirst;
  const p = new Contract(w.pair, PAIR_ABI, provider) as Dyn;
  const t0: string = await p.token0();
  const plsFirst = t0.toLowerCase() === CFG.wpls.toLowerCase();
  watched.setPlsFirst(w.token, plsFirst);
  return plsFirst;
}

/** Mid price in PLS per token, straight from pair reserves. */
async function readPair(pairAddr: string, decimals: number, plsFirst: boolean):
  Promise<{ price: number; liq: number } | null> {
  try {
    const p = new Contract(pairAddr, PAIR_ABI, provider) as Dyn;
    const [r0, r1] = await p.getReserves();
    const plsRes = BigInt(plsFirst ? r0 : r1);
    const tokRes = BigInt(plsFirst ? r1 : r0);
    if (plsRes === 0n || tokRes === 0n) return null;
    const pls = Number(formatUnits(plsRes, 18));
    const tok = Number(formatUnits(tokRes, decimals));
    return { price: pls / tok, liq: pls };
  } catch {
    return null;
  }
}

// Swap(address,uint256,uint256,uint256,uint256,address) - the standard V2
// pair event, identical across every PulseX pair contract regardless of
// which token it holds. Scanning by this single topic with NO address
// filter, rather than one getLogs call per watched pair, keeps this to one
// request per chunk no matter how many tokens the keeper is watching - the
// same reasoning launch.ts's factory-wide PairCreated scan already relies
// on, just applied to pairs instead of the factory.
const SWAP_TOPIC0 = id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_IFACE = new Interface(PAIR_ABI);

// Deliberately smaller than launch.ts's LOG_CHUNK_BLOCKS: an unfiltered
// chain-wide Swap scan returns every DEX trade in range, not just this
// factory's pair creations, so a chunk sized for PairCreated risks an
// oversized response here. Configurable per RPC provider same as that one.
const SWAP_LOG_CHUNK_BLOCKS = Math.max(1, Number(process.env.SWAP_LOG_CHUNK_BLOCKS || "200"));

/**
 * Chunked, checkpointed scan for Swap events on every pair the keeper is
 * watching, accumulating WPLS-denominated trade size per token into
 * token_volume_accum (see db.ts's volumeAccum) - pollAll() drains that into
 * each price tick's vol column right after this runs. Same
 * scan-forward-only, checkpoint-per-chunk shape as launch.ts's scan() for
 * PairCreated: no backfill of history from before the keeper started
 * watching, and a failure partway through a catch-up keeps the progress
 * already made rather than losing it.
 */
export async function scanSwapVolume(): Promise<void> {
  const list = watched.all();
  if (list.length === 0) return;
  const pairIndex = new Map<string, { token: string; plsFirst: boolean }>();
  for (const w of list) pairIndex.set(w.pair.toLowerCase(), { token: w.token, plsFirst: await resolvePlsFirst(w) });

  // Uses logsProvider throughout, not provider - see chain.ts's comment.
  // Mixing providers for the block-number read and the getLogs call could
  // ask the getLogs endpoint for a block range past what it's actually
  // synced to, if the two providers are ever a few blocks apart.
  const head = await logsProvider.getBlockNumber();
  const last = Number(meta.get("last_swap_block", String(head - 200)));
  if (head <= last) return;

  const from = Math.max(last + 1, head - 2000); // cap catch-up per pass
  let totalMatched = 0;
  let chunkStart = from;
  while (chunkStart <= head) {
    const chunkEnd = Math.min(chunkStart + SWAP_LOG_CHUNK_BLOCKS - 1, head);
    try {
      const logs = await logsProvider.getLogs({ fromBlock: chunkStart, toBlock: chunkEnd, topics: [SWAP_TOPIC0] });
      for (const l of logs) {
        const hit = pairIndex.get(l.address.toLowerCase());
        if (!hit) continue; // a swap on some other pair entirely - not ours
        let parsed;
        try { parsed = SWAP_IFACE.parseLog(l); } catch { continue; }
        if (!parsed) continue;
        const { amount0In, amount1In, amount0Out, amount1Out, to } = parsed.args;
        // WPLS IN to the pair means someone paid WPLS for the token - a buy.
        // WPLS OUT means someone sold the token for WPLS. A real swap only
        // ever has one side non-zero (the pair enforces one direction per
        // call), so this in/out split is a clean buy/sell classification,
        // not a guess - see Hunter Bot's order-flow signals (indicators.ts's
        // orderFlow), which need to know which side a trade was on, not
        // just that a trade happened.
        const wplsIn: bigint = hit.plsFirst ? (amount0In as bigint) : (amount1In as bigint);
        const wplsOut: bigint = hit.plsFirst ? (amount0Out as bigint) : (amount1Out as bigint);
        const wplsAmount = wplsIn + wplsOut;
        if (wplsAmount <= 0n) continue;
        const side: "buy" | "sell" = wplsIn > 0n ? "buy" : "sell";
        volumeAccum.add(hit.token, Number(formatEther(wplsAmount)), side);
        // "to" is the swap's real output recipient - the router forwards
        // each hop's output to the actual next address, and these are
        // single-pair token/WPLS swaps (not multi-hop), so it's the real
        // trader's own wallet on both a buy and a sell, not the router
        // itself (that's "sender", which is unused here - see PAIR_ABI's
        // comment and token_traders' own comment in db.ts for why this
        // matters: distinct wallets, not just a trade count). Stamped with
        // "now" like every other value scanSwapVolume feeds into this poll
        // cycle (see pollAll's own single `ts`), not the swap's real block
        // time - consistent with the rest of this file, and avoids an
        // extra per-log RPC call just for a timestamp.
        tokenTraders.record(hit.token, to as string, Math.floor(Date.now() / 1000), side);
        totalMatched++;
      }
      meta.set("last_swap_block", String(chunkEnd));
      chunkStart = chunkEnd + 1;
    } catch (e) {
      log("error", "prices", `Swap scan ${chunkStart}-${chunkEnd} failed: ${(e as Error).message}`);
      return;
    }
  }
  if (totalMatched) log("debug", "prices", `Swap scan ${from}-${head}: ${totalMatched} matching trades`);
}

export async function pollAll(): Promise<void> {
  await scanSwapVolume();

  const list = watched.all();
  const ts = Math.floor(Date.now() / 1000);
  let ok = 0;
  for (const w of list) {
    const plsFirst = await resolvePlsFirst(w);
    const r = await readPair(w.pair, w.decimals, plsFirst);
    if (!r) continue;
    const drained = volumeAccum.drain(w.token);
    prices.insert.run(
      w.token, ts, r.price, r.liq, drained.vol, drained.trades,
      drained.buyVol, drained.sellVol, drained.buyTrades, drained.sellTrades,
    );
    ok++;
  }
  log("debug", "prices", `Sampled ${ok}/${list.length} tokens`);
  // Keep 45 days. Longer lookbacks than that are not useful on these markets.
  if (ts % 3600 < CFG.pricePollSec) prices.prune(ts - 45 * 86400);
  // Keep 2 days - nothing reads token_traders further back than the 24h/48h
  // windows minUniqueTraders24h actually checks, unlike prices' own real
  // indicator lookback.
  if (ts % 3600 < CFG.pricePollSec) tokenTraders.prune(ts - 2 * 86400);
}

export interface Window { high: number; low: number; last: number; points: number; hours: number }

export function windowStats(token: string, hours: number): Window | null {
  const from = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = prices.since(token, from);
  if (rows.length < 3) return null;
  let high = -Infinity, low = Infinity;
  for (const r of rows) { if (r.price > high) high = r.price; if (r.price < low) low = r.price; }
  return {
    high, low,
    last: rows[rows.length - 1]!.price,
    points: rows.length,
    hours: (rows[rows.length - 1]!.ts - rows[0]!.ts) / 3600,
  };
}

export const coverageHours = (t: string): number => prices.coverageHours(t);
