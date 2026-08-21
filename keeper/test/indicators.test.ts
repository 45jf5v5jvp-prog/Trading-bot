import test from "node:test";
import assert from "node:assert/strict";
import { toCandles } from "../src/candles.js";
import { rsi, macd, bollinger, atr, volumeConfirmation, snapshot, liquidityDropIsSuspicious } from "../src/indicators.js";

test("toCandles buckets ticks by interval and tracks high/low/open/close", () => {
  const rows = [
    { ts: 0, price: 10, liq: 100, vol: 5 },
    { ts: 30, price: 12, liq: 110, vol: 7 },
    { ts: 61, price: 9, liq: 90, vol: 3 },   // next bucket (bucketSeconds=60)
    { ts: 90, price: 11, liq: 95, vol: 4 },
  ];
  const candles = toCandles(rows, 60);
  assert.equal(candles.length, 2);
  assert.equal(candles[0]!.open, 10);
  assert.equal(candles[0]!.high, 12);
  assert.equal(candles[0]!.low, 10);
  assert.equal(candles[0]!.close, 12);
  assert.equal(candles[1]!.open, 9);
  assert.equal(candles[1]!.close, 11);
});

test("toCandles sums vol across every tick in a bucket, not just the last one", () => {
  const rows = [
    { ts: 0, price: 10, liq: 100, vol: 5 },
    { ts: 30, price: 12, liq: 110, vol: 7 },
    { ts: 61, price: 9, liq: 90, vol: 3 }, // next bucket
  ];
  const candles = toCandles(rows, 60);
  assert.equal(candles[0]!.vol, 12); // 5 + 7
  assert.equal(candles[1]!.vol, 3);
});

test("toCandles treats a missing vol as 0 rather than throwing", () => {
  const rows = [{ ts: 0, price: 10, liq: 100 }] as any;
  const candles = toCandles(rows, 60);
  assert.equal(candles[0]!.vol, 0);
});

test("toCandles returns [] for no rows", () => {
  assert.deepEqual(toCandles([], 60), []);
});

test("rsi is null with too little history", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});

test("rsi is 100 on an unbroken uptrend", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 1 + i);
  assert.equal(rsi(closes, 14), 100);
});

test("rsi is 0 on an unbroken downtrend", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(rsi(closes, 14), 0);
});

test("rsi sits at 50 on a flat series", () => {
  const closes = Array.from({ length: 20 }, () => 5);
  assert.equal(rsi(closes, 14), 50);
});

test("macd is null with too little history", () => {
  assert.equal(macd([1, 2, 3]), null);
});

test("macd detects a bullish cross the instant it happens", () => {
  // Falling then sharply rising - the macd line crosses up through the
  // slower-moving signal line right at the start of the recovery leg. The
  // series is sized so the array ends exactly on that crossing candle -
  // bullishCross only fires on the most recent two points, not on "is
  // currently above," so a longer recovery tail would move past the cross
  // and correctly report false again (checked by the next test).
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  const rising = Array.from({ length: 2 }, (_, i) => 60 + i * 3);
  const m = macd([...falling, ...rising]);
  assert.ok(m);
  assert.equal(m!.bullishCross, true);
});

test("macd stops reporting a cross once the trend has settled above the signal", () => {
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  const rising = Array.from({ length: 20 }, (_, i) => 60 + i * 3);
  const m = macd([...falling, ...rising]);
  assert.ok(m);
  assert.equal(m!.bullishCross, false);
  assert.ok(m!.histogram > 0); // still a bullish state, just not a fresh cross
});

test("bollinger is null with too little history", () => {
  assert.equal(bollinger([1, 2, 3], 20), null);
});

test("bollinger percentB is 0.5 on a flat series (no spread)", () => {
  const closes = Array.from({ length: 20 }, () => 7);
  const b = bollinger(closes, 20);
  assert.ok(b);
  assert.equal(b!.mid, 7);
  assert.equal(b!.percentB, 0.5);
});

test("bollinger percentB approaches 1 when price pushes to a new high", () => {
  const closes = [...Array.from({ length: 19 }, () => 10), 20];
  const b = bollinger(closes, 20);
  assert.ok(b);
  assert.ok(b!.percentB > 0.9);
});

test("atr is null with too little history", () => {
  const candles = Array.from({ length: 5 }, (_, i) => ({ ts: i * 60, open: i, high: i + 1, low: i, close: i, liq: 1000, vol: 0 }));
  assert.equal(atr(candles, 14), null);
});

test("atr is 0 on a perfectly flat series (no range at all)", () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({ ts: i * 60, open: 10, high: 10, low: 10, close: 10, liq: 1000, vol: 0 }));
  assert.equal(atr(candles, 14), 0);
});

test("atr reports a positive value that scales with a wider daily range", () => {
  const tight = Array.from({ length: 20 }, (_, i) => ({ ts: i * 60, open: 10, high: 10.1, low: 9.9, close: 10, liq: 1000, vol: 0 }));
  const wide = Array.from({ length: 20 }, (_, i) => ({ ts: i * 60, open: 10, high: 12, low: 8, close: 10, liq: 1000, vol: 0 }));
  const tightAtr = atr(tight, 14);
  const wideAtr = atr(wide, 14);
  assert.ok(tightAtr !== null && wideAtr !== null);
  assert.ok(wideAtr! > tightAtr!);
});

test("volumeConfirmation is null with too few candles to split into recent/baseline", () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({ ts: i * 60, open: 1, high: 1, low: 1, close: 1, liq: 1000, vol: 5 }));
  assert.equal(volumeConfirmation(candles, 8), null);
});

test("volumeConfirmation ratio is above 1 when recent volume is running hotter than baseline", () => {
  const baseline = Array.from({ length: 16 }, (_, i) => ({ ts: i * 60, open: 1, high: 1, low: 1, close: 1, liq: 1000, vol: 10 }));
  const recent = Array.from({ length: 8 }, (_, i) => ({ ts: (16 + i) * 60, open: 1, high: 1, low: 1, close: 1, liq: 1000, vol: 40 }));
  const v = volumeConfirmation([...baseline, ...recent], 8);
  assert.ok(v);
  assert.equal(v!.baselineAvgVolPls, 10);
  assert.equal(v!.recentAvgVolPls, 40);
  assert.equal(v!.ratio, 4);
});

test("volumeConfirmation treats a zero baseline with real recent volume as unbounded confirmation, not a crash", () => {
  const baseline = Array.from({ length: 16 }, (_, i) => ({ ts: i * 60, open: 1, high: 1, low: 1, close: 1, liq: 1000, vol: 0 }));
  const recent = Array.from({ length: 8 }, (_, i) => ({ ts: (16 + i) * 60, open: 1, high: 1, low: 1, close: 1, liq: 1000, vol: 5 }));
  const v = volumeConfirmation([...baseline, ...recent], 8);
  assert.ok(v);
  assert.equal(v!.ratio, Infinity);
});

test("volumeConfirmation is neutral (ratio 1) when neither baseline nor recent has any volume on file", () => {
  const candles = Array.from({ length: 24 }, (_, i) => ({ ts: i * 60, open: 1, high: 1, low: 1, close: 1, liq: 1000, vol: 0 }));
  const v = volumeConfirmation(candles, 8);
  assert.ok(v);
  assert.equal(v!.ratio, 1);
});

test("snapshot returns null on an empty candle set", () => {
  assert.equal(snapshot([]), null);
});

test("snapshot combines rsi/macd/bollinger/atr/volRatio off the same candles", () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({ ts: i * 60, open: i, high: i + 0.5, low: i - 0.5, close: i, liq: 1000, vol: 10 }));
  const s = snapshot(candles);
  assert.ok(s);
  assert.equal(s!.close, 39);
  assert.ok(s!.rsi !== null);
  assert.ok(s!.bollinger !== null);
  assert.ok(s!.atrPct !== null);
  assert.ok(s!.volRatio !== null);
});

test("snapshot's atrPct is expressed as a % of the latest close, not a raw price unit", () => {
  // A constant 1-unit high-low spread every candle gives ATR = 1 exactly -
  // on a close of 100 that's 1% of price.
  const candles = Array.from({ length: 20 }, (_, i) => ({ ts: i * 60, open: 100, high: 100.5, low: 99.5, close: 100, liq: 1000, vol: 0 }));
  const s = snapshot(candles);
  assert.ok(s);
  assert.ok(s!.atrPct !== null);
  assert.ok(Math.abs(s!.atrPct! - 1) < 0.01);
});

test("liquidityDropIsSuspicious is false for a price drop with no liquidity change (rise, not a dip)", () => {
  assert.equal(liquidityDropIsSuspicious(10, 12, 1_000_000, 1_000_000), false);
});

test("liquidityDropIsSuspicious is false when liquidity falls in line with organic selling", () => {
  // 50% price drop from pure trading implies WPLS-side liquidity falls to
  // about sqrt(0.5) ~= 70.7% of its prior value - right at that line is not
  // suspicious.
  const liqBefore = 1_000_000;
  const expectedLiqNow = liqBefore * Math.sqrt(0.5);
  assert.equal(liquidityDropIsSuspicious(10, 5, liqBefore, expectedLiqNow), false);
});

test("liquidityDropIsSuspicious is true when liquidity collapsed far more than the price move explains - the LP-pull signature", () => {
  // Same 50% price drop, but liquidity fell to 10% instead of the ~70.7%
  // organic trading would produce - liquidity was pulled, not traded away.
  assert.equal(liquidityDropIsSuspicious(10, 5, 1_000_000, 100_000), true);
});

test("liquidityDropIsSuspicious treats unusable inputs as suspicious rather than guessing", () => {
  assert.equal(liquidityDropIsSuspicious(0, 5, 1_000_000, 500_000), true);
  assert.equal(liquidityDropIsSuspicious(10, 5, 0, 500_000), true);
});
