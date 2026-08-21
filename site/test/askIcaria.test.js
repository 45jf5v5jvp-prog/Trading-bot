const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

// Covers buildTechnicalProfile/priceMovePct only - the rest of askIcaria.js
// (simulate/lpLockedPct/ownerRenounced/buildProfile) makes live chain calls
// and isn't unit-testable without a much heavier mock than this file's
// scope warrants. This is the piece the "Ask Icaria answers too generically,
// doesn't use price action" fix actually touches.

const FAKE_DB = path.join(__dirname, "fake-keeper-ask.db");
for (const p of [FAKE_DB, FAKE_DB + "-wal", FAKE_DB + "-shm"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
const setup = new Database(FAKE_DB);
setup.exec(`
  CREATE TABLE prices (
    token TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL, liq REAL NOT NULL, vol REAL NOT NULL,
    PRIMARY KEY (token, ts)
  );
`);
const NOW = 1_000_000;
const TOKEN = "0x" + "a".repeat(40);
// A gentle uptrend over the last 48h, sampled every 15 minutes - enough
// candles for a real RSI(14)/MACD/Bollinger(20)/ATR(14) read.
const insert = setup.prepare("INSERT INTO prices (token,ts,price,liq,vol) VALUES (?,?,?,?,?)");
for (let i = 0; i < 200; i++) {
  const ts = NOW - (200 - i) * 900; // 15-minute steps
  insert.run(TOKEN, ts, 1 + i * 0.01, 500000 + i * 100, 10 + (i % 5));
}
setup.close();

process.env.KEEPER_DB_PATH = FAKE_DB;
const { priceMovePct, buildTechnicalProfile } = require("../lib/askIcaria");

test("priceMovePct is null with fewer than 2 rows in the window", () => {
  assert.equal(priceMovePct([{ ts: 100, price: 1 }], 0), null);
  assert.equal(priceMovePct([], 0), null);
});

test("priceMovePct computes % change from the first to the last row within the window", () => {
  const rows = [{ ts: 0, price: 10 }, { ts: 50, price: 11 }, { ts: 100, price: 12 }];
  assert.equal(priceMovePct(rows, 0), 20); // (12-10)/10 * 100
  assert.equal(priceMovePct(rows, 60), null); // only the ts=100 row qualifies - fewer than 2
});

test("priceMovePct is null when the first in-window price is 0 (nothing to divide by)", () => {
  assert.equal(priceMovePct([{ ts: 0, price: 0 }, { ts: 50, price: 5 }], 0), null);
});

test("buildTechnicalProfile returns all-null fields for a token with no price history", () => {
  const p = buildTechnicalProfile("0x" + "b".repeat(40));
  assert.equal(p.priceNow, null);
  assert.equal(p.rsi, null);
  assert.equal(p.historyHours, 0);
});

test("buildTechnicalProfile reports a real price and technical read for a watched token", () => {
  const p = buildTechnicalProfile(TOKEN, NOW * 1000);
  assert.ok(p.priceNow > 0);
  assert.ok(p.historyHours > 40); // ~48h of 15-minute samples
  assert.ok(p.rsi !== null);
  assert.ok(p.priceMove24hPct > 0); // a steady uptrend
});
