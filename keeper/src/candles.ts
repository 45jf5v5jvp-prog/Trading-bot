import { prices, type PricePoint } from "./db.js";

export interface Candle {
  ts: number;   // bucket start, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  // The prices table has no volume column - PulseX gives no cheap way to read
  // historical swap volume from reserves alone. Liquidity at candle close
  // stands in for it: a real breakout should show liquidity moving too, the
  // same signal discovery.ts already leans on for the same reason.
  liq: number;
}

/**
 * Buckets raw price ticks (see prices.ts - one row roughly every
 * PRICE_POLL_SEC, not a fixed candle interval) into OHLC candles. A bucket
 * with only one tick still produces a valid (flat) candle; indicators.ts
 * callers are expected to require enough candles for their own period,
 * not enough ticks per candle.
 */
export function toCandles(rows: PricePoint[], bucketSeconds: number): Candle[] {
  if (rows.length === 0) return [];
  const buckets = new Map<number, PricePoint[]>();
  for (const r of rows) {
    const key = Math.floor(r.ts / bucketSeconds) * bucketSeconds;
    const arr = buckets.get(key);
    if (arr) arr.push(r); else buckets.set(key, [r]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((k) => {
    const ticks = buckets.get(k)!;
    let high = -Infinity, low = Infinity;
    for (const t of ticks) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
    }
    return {
      ts: k, open: ticks[0]!.price, high, low,
      close: ticks[ticks.length - 1]!.price, liq: ticks[ticks.length - 1]!.liq,
    };
  });
}

export function candlesForToken(token: string, sinceTs: number, bucketSeconds: number): Candle[] {
  return toCandles(prices.since(token, sinceTs), bucketSeconds);
}
