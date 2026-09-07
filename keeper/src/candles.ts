import { prices, type PricePoint } from "./db.js";

export interface Candle {
  ts: number;   // bucket start, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  // Liquidity at candle close - a real breakout should show liquidity
  // moving too, the same signal discovery.ts already leans on for the same
  // reason.
  liq: number;
  // Summed WPLS-denominated Swap volume across every tick in the bucket
  // (see prices.ts's scanSwapVolume) - unlike liq/close this is a SUM, not
  // the last tick's value, since volume is a flow over the interval, not a
  // point-in-time reading. 0 for any bucket the volume scanner hasn't
  // covered yet (an old price row from before it existed, or a token whose
  // pair the scanner hasn't matched a Swap event for), not a missing value -
  // indicators.ts's volumeConfirmation() treats a real zero and "no data
  // yet" identically, both read as "no confirming volume."
  vol: number;
  // Count of matched Swap events across every tick in the bucket - same
  // summed-over-the-interval reasoning as vol, but a trade count rather
  // than a PLS amount. See hunter.ts's minTrades24h: a token can show real
  // $ volume off one whale trade while otherwise dead, or modest $ volume
  // while genuinely trading often - trade count answers "is this actually
  // being traded" without needing a per-token dollar guess.
  trades: number;
  // buyVol/sellVol/buyTrades/sellTrades split vol/trades above by which
  // side of the swap WPLS was on (see prices.ts's scanSwapVolume) - what
  // Hunter Bot's order-flow signals (indicators.ts's orderFlow) actually
  // read. Same "0 means no data yet, not a real zero" convention as vol.
  buyVol: number;
  sellVol: number;
  buyTrades: number;
  sellTrades: number;
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
    let high = -Infinity, low = Infinity, vol = 0, trades = 0, buyVol = 0, sellVol = 0, buyTrades = 0, sellTrades = 0;
    for (const t of ticks) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      vol += t.vol ?? 0;
      trades += t.trades ?? 0;
      buyVol += t.buyVol ?? 0;
      sellVol += t.sellVol ?? 0;
      buyTrades += t.buyTrades ?? 0;
      sellTrades += t.sellTrades ?? 0;
    }
    return {
      ts: k, open: ticks[0]!.price, high, low,
      close: ticks[ticks.length - 1]!.price, liq: ticks[ticks.length - 1]!.liq, vol, trades,
      buyVol, sellVol, buyTrades, sellTrades,
    };
  });
}

export function candlesForToken(token: string, sinceTs: number, bucketSeconds: number): Candle[] {
  return toCandles(prices.since(token, sinceTs), bucketSeconds);
}
