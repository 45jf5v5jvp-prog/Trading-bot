import type { Candle } from "./candles.js";

/**
 * Standard technical indicators computed from candle closes. Pure math, no
 * chain or database dependency - same reasoning as portfolio.ts's exit math.
 *
 * These describe a token's own trading pattern. None of them know whether
 * the token is a honeypot, whether its owner can drain it, or whether its
 * liquidity is real - that is still screener.ts's job, run separately by
 * hunter.ts before anything gets bought. An oversold RSI on a rug is still
 * a rug.
 */

/** Wilder's RSI. Needs period+1 closes; returns null otherwise. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gainSum += d; else lossSum += -d;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const gain = d >= 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Exponential moving average series. Returns [] if fewer than `period` closes. */
function emaSeries(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [seed];
  for (let i = period; i < closes.length; i++) out.push(closes[i]! * k + out[out.length - 1]! * (1 - k));
  return out;
}

export interface Macd { macd: number; signal: number; histogram: number; bullishCross: boolean; bearishCross: boolean }

/**
 * Standard MACD(12,26,9). A cross is read off the last two points of the
 * macd-minus-signal series, so it needs enough closes for the slow EMA plus
 * the signal EMA plus one - returns null well short of that rather than
 * guessing off a half-formed line.
 */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): Macd | null {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  if (slowE.length === 0) return null;
  // Align: slowE[0] corresponds to the candle at index `slow-1`; fastE[0] to
  // index `fast-1`. Slice fastE so both series start at the same candle.
  const offset = slow - fast;
  const fastAligned = fastE.slice(offset);
  const len = Math.min(fastAligned.length, slowE.length);
  const macdLine: number[] = [];
  for (let i = 0; i < len; i++) macdLine.push(fastAligned[i]! - slowE[i]!);

  const signalLine = emaSeries(macdLine, signalPeriod);
  if (signalLine.length < 2) return null;
  const macdTail = macdLine.slice(macdLine.length - signalLine.length);

  const lastMacd = macdTail[macdTail.length - 1]!;
  const lastSignal = signalLine[signalLine.length - 1]!;
  const prevMacd = macdTail[macdTail.length - 2]!;
  const prevSignal = signalLine[signalLine.length - 2]!;

  // A hairline epsilon dead zone around zero - without it, two EMA chains
  // that converge to the "same" value during a flat run land a few
  // femto-units apart from floating-point rounding, and a strict <= flips
  // unpredictably on noise that has no real trading meaning.
  const EPS = 1e-9;
  const prevDiff = prevMacd - prevSignal;
  const lastDiff = lastMacd - lastSignal;

  return {
    macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal,
    bullishCross: prevDiff <= EPS && lastDiff > EPS,
    bearishCross: prevDiff >= -EPS && lastDiff < -EPS,
  };
}

export interface Bollinger { mid: number; upper: number; lower: number; percentB: number }

/** Bollinger Bands(20,2). percentB: 0 = at the lower band, 1 = at the upper. */
export function bollinger(closes: number[], period = 20, mult = 2): Bollinger | null {
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  const mid = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, c) => a + (c - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const last = closes[closes.length - 1]!;
  const percentB = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { mid, upper, lower, percentB };
}

/**
 * Distinguishes an organic sell-driven dip from liquidity being pulled.
 *
 * In a constant-product pool (x*y=k), pure swap trading ties the WPLS-side
 * reserve to price: selling the token in moves along the curve, and a price
 * drop of `priceRatio` from trading alone implies the WPLS reserve falls to
 * about sqrt(priceRatio) of what it was - a 50% price drop from selling
 * alone drops WPLS-side liquidity by about 29%, not 50%.
 *
 * Pulling LP instead scales both reserves down together, by whatever share
 * was removed, independent of that relationship. So when liquidity has
 * fallen MORE than the price move alone would predict, something removed
 * liquidity on top of (or instead of) organic trading - LP being pulled is
 * the leading explanation, and exactly the "price cratered, looks like a
 * buyable dip, is actually a rug" trap hunter.ts exists to avoid.
 *
 * `toleranceRatio` (default 0.85) allows slack for pool-fee drift and
 * sampling noise: only flagged when liquidity fell to less than
 * toleranceRatio of what pure trading would predict.
 */
export function liquidityDropIsSuspicious(
  priceBefore: number, priceNow: number, liqBefore: number, liqNow: number, toleranceRatio = 0.85,
): boolean {
  if (priceBefore <= 0 || liqBefore <= 0 || priceNow <= 0 || liqNow < 0) return true;
  const priceRatio = priceNow / priceBefore;
  if (priceRatio >= 1) return false; // price didn't fall, nothing to explain
  const expectedLiqRatio = Math.sqrt(priceRatio);
  const actualLiqRatio = liqNow / liqBefore;
  return actualLiqRatio < expectedLiqRatio * toleranceRatio;
}

/**
 * Is this token's own USD value just sitting near $1, with everything that
 * looks like a real PLS-denominated price move actually coming from PLS/USD
 * itself moving, not the token? Confirmed live 2026-08-24: Hunter bought
 * USDL, PDAI, and LUSD - real, heavily-traded, well-liquidity USD-pegged
 * tokens, on RSI-oversold/Bollinger-lower-band readings computed from their
 * PLS-denominated price. None of those readings meant anything: a
 * stablecoin's PLS price is, by construction, mostly just the inverse of
 * PLS/USD, so when PLS itself swings, every USD-pegged token on the whole
 * chain shows the exact same "oversold" or "overbought" shape at once, with
 * nothing token-specific behind it. A dip-buying strategy's whole premise -
 * this fell too far, it should revert - doesn't apply to a token that was
 * never supposed to move in the first place. Liquidity/trade-count/unique-
 * wallet filters (this session's other guards) don't catch this at all - a
 * real stablecoin usually has MORE liquidity and MORE real traders than a
 * fresh microcap, not less.
 *
 * Checked over the WHOLE sampled window, not just the latest price - has to
 * have priced within `bandPct` of $1 on every sample to count, not just
 * look calm right now. A real memecoin sitting inside a tight band around
 * exactly $1.00 for the whole lookback window by pure coincidence is not a
 * realistic false positive.
 */
export function looksLikeStablecoin(pricesInPls: number[], plsUsdPrice: number, bandPct = 5): boolean {
  if (pricesInPls.length === 0 || plsUsdPrice <= 0) return false;
  return pricesInPls.every((p) => p > 0 && Math.abs(p * plsUsdPrice - 1) <= bandPct / 100);
}

/**
 * Wilder's ATR (Average True Range) - a volatility measure, not a
 * direction/oversold signal like the other three. True range per candle is
 * the largest of: this candle's own high-low spread, or the gap from the
 * PRIOR close to this candle's high or low - the gap terms are what let ATR
 * capture a gap move that a same-candle high-low spread alone would miss.
 * Same Wilder smoothing as rsi() above, over the same default 14-period.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, prev = candles[i - 1]!;
    trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  let avg = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) avg = (avg * (period - 1) + trueRanges[i]!) / period;
  return avg;
}

export interface VolumeConfirmation { recentAvgVolPls: number; baselineAvgVolPls: number; ratio: number }

/**
 * Is there real trading volume behind the recent candles, or is this token
 * just drifting on thin activity? Compares the average volume of the most
 * recent `recentCount` candles against the average of everything before
 * them. A ratio above 1 means recent activity is running hotter than the
 * token's own baseline - the confirmation a technical setup (RSI/MACD/
 * Bollinger) needs before it's trustworthy, since an oversold reading on a
 * token nobody is actually trading is not a signal, it's noise.
 *
 * Needs enough candles on BOTH sides of the split to mean anything; returns
 * null rather than comparing a lopsided sample. A baseline of exactly 0
 * volume (a token the keeper has price ticks for but never saw a matching
 * Swap event on) reports Infinity if there's any recent volume at all, or a
 * neutral 1 if there's none either - never a division by zero.
 */
export function volumeConfirmation(candles: Candle[], recentCount = 8): VolumeConfirmation | null {
  if (candles.length < recentCount * 2) return null;
  const recent = candles.slice(candles.length - recentCount);
  const baseline = candles.slice(0, candles.length - recentCount);
  const avg = (cs: Candle[]) => cs.reduce((a, c) => a + c.vol, 0) / cs.length;
  const recentAvgVolPls = avg(recent);
  const baselineAvgVolPls = avg(baseline);
  const ratio = baselineAvgVolPls > 0 ? recentAvgVolPls / baselineAvgVolPls : (recentAvgVolPls > 0 ? Infinity : 1);
  return { recentAvgVolPls, baselineAvgVolPls, ratio };
}

export interface IndicatorSnapshot {
  close: number; rsi: number | null; macd: Macd | null; bollinger: Bollinger | null;
  atrPct: number | null; volRatio: number | null;
}

/** Every indicator at once, off the same candle set. Any that lack enough
 * history come back null rather than a misleading half-formed value. */
export function snapshot(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length === 0) return null;
  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1]!;
  const atrVal = atr(candles);
  const vol = volumeConfirmation(candles);
  return {
    close,
    rsi: rsi(closes),
    macd: macd(closes),
    bollinger: bollinger(closes),
    // As a % of price, not a raw PLS-per-token figure, so it's comparable
    // across tokens of wildly different unit prices - the same thing
    // stopLossPct already is.
    atrPct: atrVal !== null && close > 0 ? (atrVal / close) * 100 : null,
    volRatio: vol?.ratio ?? null,
  };
}
