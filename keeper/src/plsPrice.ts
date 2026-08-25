import { log } from "./log.js";
import { fetchWithTimeout } from "./httpTimeout.js";

/**
 * PLS/USD, fetched from CoinGecko's public simple-price endpoint and cached.
 * The only consumer is marketSeed.ts, converting its $-denominated liquidity
 * floor into a PLS amount the on-chain reserve reads can compare directly -
 * nothing that touches funds depends on this being exact, so a stale cached
 * price (or the fallback below) is fine. An outage here should narrow or
 * widen the market-seed floor slightly, never block it.
 */

let cached: { price: number; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;
// Rough floor if CoinGecko is ever unreachable (or the "pulsechain" id ever
// changes), so seeding still runs with a sane if imprecise threshold rather
// than stalling. Worth revisiting if PLS's real price drifts far from this.
const FALLBACK_USD = 0.00003;

export async function plsUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.price;
  try {
    const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=pulsechain&vs_currencies=usd");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { pulsechain?: { usd?: number } };
    const p = j.pulsechain?.usd;
    if (!p || !Number.isFinite(p) || p <= 0) throw new Error("no usable price in response");
    cached = { price: p, at: Date.now() };
    return p;
  } catch (e) {
    const using = cached ? `last known $${cached.price}` : `fallback $${FALLBACK_USD}`;
    log("warn", "plsPrice", `Could not fetch PLS/USD (${(e as Error).message}), using ${using}`);
    return cached?.price ?? FALLBACK_USD;
  }
}
