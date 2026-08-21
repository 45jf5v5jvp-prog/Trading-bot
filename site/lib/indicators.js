/**
 * Candle bucketing + technical indicator math for Ask Icaria's price read.
 * A JS port of keeper/src/candles.ts and keeper/src/indicators.ts, kept
 * identical on purpose - same reasoning as this file's neighbor
 * askIcaria.js duplicating BURN_ADDRESSES rather than sharing a module
 * across the TS/JS boundary (the site and keeper are separate deployments,
 * one compiled TypeScript/ESM, one plain Node/CommonJS).
 */

/** Buckets raw price ticks (see keeperDb.js's getRecentPrices) into OHLC
 * candles, summing vol across every tick in a bucket. */
function toCandles(rows, bucketSeconds) {
  if (rows.length === 0) return [];
  const buckets = new Map();
  for (const r of rows) {
    const key = Math.floor(r.ts / bucketSeconds) * bucketSeconds;
    const arr = buckets.get(key);
    if (arr) arr.push(r); else buckets.set(key, [r]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((k) => {
    const ticks = buckets.get(k);
    let high = -Infinity, low = Infinity, vol = 0;
    for (const t of ticks) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      vol += t.vol ?? 0;
    }
    return {
      ts: k, open: ticks[0].price, high, low,
      close: ticks[ticks.length - 1].price, liq: ticks[ticks.length - 1].liq, vol,
    };
  });
}

/** Wilder's RSI. Needs period+1 closes; returns null otherwise. */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gainSum += d; else lossSum += -d;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d >= 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function emaSeries(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [seed];
  for (let i = period; i < closes.length; i++) out.push(closes[i] * k + out[out.length - 1] * (1 - k));
  return out;
}

/** Standard MACD(12,26,9). */
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  if (slowE.length === 0) return null;
  const offset = slow - fast;
  const fastAligned = fastE.slice(offset);
  const len = Math.min(fastAligned.length, slowE.length);
  const macdLine = [];
  for (let i = 0; i < len; i++) macdLine.push(fastAligned[i] - slowE[i]);

  const signalLine = emaSeries(macdLine, signalPeriod);
  if (signalLine.length < 2) return null;
  const macdTail = macdLine.slice(macdLine.length - signalLine.length);

  const lastMacd = macdTail[macdTail.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const prevMacd = macdTail[macdTail.length - 2];
  const prevSignal = signalLine[signalLine.length - 2];

  const EPS = 1e-9;
  const prevDiff = prevMacd - prevSignal;
  const lastDiff = lastMacd - lastSignal;

  return {
    macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal,
    bullishCross: prevDiff <= EPS && lastDiff > EPS,
    bearishCross: prevDiff >= -EPS && lastDiff < -EPS,
  };
}

/** Bollinger Bands(20,2). percentB: 0 = at the lower band, 1 = at the upper. */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  const mid = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, c) => a + (c - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const last = closes[closes.length - 1];
  const percentB = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { mid, upper, lower, percentB };
}

/** Wilder's ATR (Average True Range). */
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  let avg = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) avg = (avg * (period - 1) + trueRanges[i]) / period;
  return avg;
}

/** Recent candle volume vs. this token's own baseline - see
 * keeper/src/indicators.ts's volumeConfirmation() for the full reasoning. */
function volumeConfirmation(candles, recentCount = 8) {
  if (candles.length < recentCount * 2) return null;
  const recent = candles.slice(candles.length - recentCount);
  const baseline = candles.slice(0, candles.length - recentCount);
  const avg = (cs) => cs.reduce((a, c) => a + c.vol, 0) / cs.length;
  const recentAvgVolPls = avg(recent);
  const baselineAvgVolPls = avg(baseline);
  const ratio = baselineAvgVolPls > 0 ? recentAvgVolPls / baselineAvgVolPls : (recentAvgVolPls > 0 ? Infinity : 1);
  return { recentAvgVolPls, baselineAvgVolPls, ratio };
}

/** Every indicator at once, off the same candle set - mirrors
 * keeper/src/indicators.ts's snapshot(). */
function snapshot(candles) {
  if (candles.length === 0) return null;
  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];
  const atrVal = atr(candles);
  const vol = volumeConfirmation(candles);
  return {
    close,
    rsi: rsi(closes),
    macd: macd(closes),
    bollinger: bollinger(closes),
    atrPct: atrVal !== null && close > 0 ? (atrVal / close) * 100 : null,
    volRatio: vol ? vol.ratio : null,
  };
}

module.exports = { toCandles, rsi, macd, bollinger, atr, volumeConfirmation, snapshot };
