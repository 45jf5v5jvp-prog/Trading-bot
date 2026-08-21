const test = require("node:test");
const assert = require("node:assert/strict");
const { toCandles, rsi, macd, bollinger, atr, volumeConfirmation, snapshot } = require("../lib/indicators");

// Ports keeper/src/candles.ts and keeper/src/indicators.ts to plain JS (see
// that file's own header comment for why they're duplicated rather than
// shared across the TS/JS boundary) - this suite checks the port behaves
// the same way, not every edge case keeper/test/indicators.test.ts already
// covers in depth.

test("toCandles buckets ticks by interval and sums vol per bucket", () => {
  const rows = [
    { ts: 0, price: 10, liq: 100, vol: 5 },
    { ts: 30, price: 12, liq: 110, vol: 7 },
    { ts: 61, price: 9, liq: 90, vol: 3 }, // next bucket (bucketSeconds=60)
  ];
  const candles = toCandles(rows, 60);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open, 10);
  assert.equal(candles[0].high, 12);
  assert.equal(candles[0].close, 12);
  assert.equal(candles[0].vol, 12);
  assert.equal(candles[1].vol, 3);
});

test("toCandles returns [] for no rows", () => {
  assert.deepEqual(toCandles([], 60), []);
});

test("rsi is null with too little history, 100 on an unbroken uptrend, 0 on an unbroken downtrend", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 1 + i), 14), 100);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14), 0);
});

test("macd detects a bullish cross at the recovery leg", () => {
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  const rising = Array.from({ length: 2 }, (_, i) => 60 + i * 3);
  const m = macd([...falling, ...rising]);
  assert.ok(m);
  assert.equal(m.bullishCross, true);
});

test("bollinger percentB is 0.5 on a flat series", () => {
  const b = bollinger(Array.from({ length: 20 }, () => 7), 20);
  assert.ok(b);
  assert.equal(b.percentB, 0.5);
});

test("atr is null with too little history, 0 on a flat series, positive with real range", () => {
  assert.equal(atr(Array.from({ length: 5 }, (_, i) => ({ high: i, low: i, close: i })), 14), null);
  const flat = Array.from({ length: 20 }, () => ({ high: 10, low: 10, close: 10 }));
  assert.equal(atr(flat, 14), 0);
  const ranged = Array.from({ length: 20 }, () => ({ high: 12, low: 8, close: 10 }));
  assert.ok(atr(ranged, 14) > 0);
});

test("volumeConfirmation ratio reflects recent activity vs. baseline", () => {
  const baseline = Array.from({ length: 16 }, () => ({ vol: 10 }));
  const recent = Array.from({ length: 8 }, () => ({ vol: 40 }));
  const v = volumeConfirmation([...baseline, ...recent], 8);
  assert.ok(v);
  assert.equal(v.ratio, 4);
});

test("snapshot combines rsi/macd/bollinger/atrPct/volRatio off the same candles", () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({ ts: i * 60, open: i, high: i + 0.5, low: i - 0.5, close: i, liq: 1000, vol: 10 }));
  const s = snapshot(candles);
  assert.ok(s);
  assert.equal(s.close, 39);
  assert.ok(s.rsi !== null);
  assert.ok(s.bollinger !== null);
  assert.ok(s.atrPct !== null);
  assert.ok(s.volRatio !== null);
});

test("snapshot returns null on an empty candle set", () => {
  assert.equal(snapshot([]), null);
});
