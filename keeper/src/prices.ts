import { Contract, formatUnits } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { ERC20_ABI, PAIR_ABI } from "./abis.js";
import { prices, watched } from "./db.js";
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
    const [sym, dec] = await Promise.all([
      erc.symbol().catch(() => "???"),
      erc.decimals().catch(() => 18),
    ]);
    watched.add(token, String(sym), Number(dec), pair);
    log("info", "prices", `Now watching ${sym} (${token})`);
    return true;
  } catch (e) {
    log("warn", "prices", `Cannot watch ${token}: ${(e as Error).message}`);
    return false;
  }
}

/** Mid price in PLS per token, straight from pair reserves. */
async function readPair(token: string, pairAddr: string, decimals: number):
  Promise<{ price: number; liq: number } | null> {
  try {
    const p = new Contract(pairAddr, PAIR_ABI, provider) as Dyn;
    const [r0, r1] = await p.getReserves();
    const t0: string = await p.token0();
    const isPlsFirst = t0.toLowerCase() === CFG.wpls.toLowerCase();
    const plsRes = BigInt(isPlsFirst ? r0 : r1);
    const tokRes = BigInt(isPlsFirst ? r1 : r0);
    if (plsRes === 0n || tokRes === 0n) return null;
    const pls = Number(formatUnits(plsRes, 18));
    const tok = Number(formatUnits(tokRes, decimals));
    return { price: pls / tok, liq: pls };
  } catch {
    return null;
  }
}

export async function pollAll(): Promise<void> {
  const list = watched.all();
  const ts = Math.floor(Date.now() / 1000);
  let ok = 0;
  for (const w of list) {
    const r = await readPair(w.token, w.pair, w.decimals);
    if (!r) continue;
    prices.insert.run(w.token, ts, r.price, r.liq);
    ok++;
  }
  log("debug", "prices", `Sampled ${ok}/${list.length} tokens`);
  // Keep 45 days. Longer lookbacks than that are not useful on these markets.
  if (ts % 3600 < CFG.pricePollSec) prices.prune(ts - 45 * 86400);
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
