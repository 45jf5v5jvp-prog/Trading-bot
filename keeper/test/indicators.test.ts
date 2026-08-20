import test from "node:test";
import assert from "node:assert/strict";
import { toCandles } from "../src/candles.js";
import { rsi, macd, bollinger, snapshot, liquidityDropIsSuspicious } from "../src/indicators.js";

test("toCandles buckets ticks by interval and tracks high/low/open/close", () => {
  const rows = [
    { ts: 0, price: 10, liq: 100 },
    { ts: 30, price: 12, liq: 110 },
    { ts: 61, price: 9, liq: 90 },   // next bucket (bucketSeconds=60)
    { ts: 90, price: 11, liq: 95 },
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

test("snapshot returns null on an empty candle set", () => {
  assert.equal(snapshot([]), null);
});

test("snapshot combines rsi/macd/bollinger off the same closes", () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({ ts: i * 60, open: i, high: i, low: i, close: i, liq: 1000 }));
  const s = snapshot(candles);
  assert.ok(s);
  assert.equal(s!.close, 39);
  assert.ok(s!.rsi !== null);
  assert.ok(s!.bollinger !== null);
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
