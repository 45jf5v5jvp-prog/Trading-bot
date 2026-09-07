import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";

// Use a throwaway database for the recordBuy tests. Must be set before importing
// anything that pulls in config/db.
process.env.DB_PATH = "/tmp/claude-0/-home-user-Trading-bot/3123e22c-cef8-5b8c-874f-df7176e2f79c/scratchpad/portfolio-test.db";
import { existsSync, rmSync } from "node:fs";
for (const p of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"])
  if (existsSync(p)) rmSync(p);

const { blend, sellSignal, exceedsHoldingCap, recordBuy } = await import("../src/portfolio.js");
const { db } = await import("../src/db.js");

test("blend averages entry price across buys", () => {
  const a = blend(0, 0n, 100, parseEther("10"));       // buy 10 tokens for 100 PLS
  assert.equal(a.spent, 100);
  assert.equal(a.tokens, 10);
  assert.equal(a.entry, 10);

  const b = blend(a.spent, a.tokensWei, 200, parseEther("10")); // 10 more for 200
  assert.equal(b.spent, 300);
  assert.equal(b.tokens, 20);
  assert.equal(b.entry, 15);                            // (100+200)/(10+10)
});

test("take profit fires past target", () => {
  const pos = { tpPct: 15, slPct: 20, trailPct: null, timeExitMin: null, openedAt: 0, highWater: 1.20, tightTrailPct: null, trailWidenAtPct: null };
  assert.match(sellSignal(pos, 1.20, 1000) ?? "", /take profit/); // up 20% >= 15% target
  assert.equal(sellSignal(pos, 1.10, 1000), null);                // up 10%, hold
});

test("stop loss fires past loss", () => {
  const pos = { tpPct: 50, slPct: 20, trailPct: null, timeExitMin: null, openedAt: 0, highWater: 1, tightTrailPct: null, trailWidenAtPct: null };
  assert.match(sellSignal(pos, 0.75, 1000) ?? "", /stop loss/);   // down 25% <= -20%
  assert.equal(sellSignal(pos, 0.85, 1000), null);                // down 15%, hold
});

test("trailing stop only arms after the position has been in profit", () => {
  const pos = { tpPct: null, slPct: null, trailPct: 10, timeExitMin: null, openedAt: 0, highWater: 1.30, tightTrailPct: null, trailWidenAtPct: null };
  // Peaked +30%, now down to +17% -> more than 10% off the peak (1.30*0.9=1.17) -> sell.
  assert.match(sellSignal(pos, 1.16, 1000) ?? "", /trailing stop/);
  assert.equal(sellSignal(pos, 1.20, 1000), null);      // only 8% off peak, hold

  // Never in profit: high_water == 1, trailing must NOT fire even on a big drop.
  const never = { ...pos, highWater: 1 };
  assert.equal(sellSignal(never, 0.5, 1000), null);
});

test("time exit fires after the window", () => {
  const pos = { tpPct: null, slPct: null, trailPct: null, timeExitMin: 30, openedAt: 0, highWater: 1, tightTrailPct: null, trailWidenAtPct: null };
  assert.equal(sellSignal(pos, 1.0, 29 * 60), null);
  assert.match(sellSignal(pos, 1.0, 30 * 60) ?? "", /time exit/);
});

test("no exit when nothing is hit", () => {
  const pos = { tpPct: 50, slPct: 30, trailPct: 15, timeExitMin: 240, openedAt: 0, highWater: 1.1, tightTrailPct: null, trailWidenAtPct: null };
  assert.equal(sellSignal(pos, 1.05, 60), null);
});

test("tiered trail: below the widen threshold, the TIGHT trail applies - a stalled quick pump exits close to its peak", () => {
  const pos = {
    tpPct: 0, slPct: 25, trailPct: 6, timeExitMin: null, openedAt: 0,
    highWater: 1.05, tightTrailPct: 2.5, trailWidenAtPct: 6,
  };
  // Peaked +5% (under the 6% widen threshold) -> tight 2.5% trail applies.
  // 1.05 * (1 - 0.025) = 1.02375 -> anything at/below that sells.
  assert.match(sellSignal(pos, 1.02, 1000) ?? "", /trailing stop/);
  assert.equal(sellSignal(pos, 1.03, 1000), null); // still inside the tight trail, hold
});

test("tiered trail: once the peak passes the widen threshold, the WIDE trail takes over and gives a real move room to run", () => {
  const pos = {
    tpPct: 0, slPct: 25, trailPct: 6, timeExitMin: null, openedAt: 0,
    highWater: 1.15, tightTrailPct: 2.5, trailWidenAtPct: 6,
  };
  // Peaked +15% (past the 6% widen threshold) -> wide 6% trail applies now,
  // not the tight one - a pullback that would have stopped out the tight
  // trail long ago is tolerated here.
  assert.equal(sellSignal(pos, 1.10, 1000), null); // ~4.3% off peak, still within the 6% wide trail
  assert.match(sellSignal(pos, 1.08, 1000) ?? "", /trailing stop/); // >6% off peak (1.15*0.94=1.081) -> sell
});

test("tiered trail falls back to plain trailPct behavior when tightTrailPct is unset (every non-Hunter bot)", () => {
  const pos = { tpPct: null, slPct: null, trailPct: 10, timeExitMin: null, openedAt: 0, highWater: 1.30, tightTrailPct: null, trailWidenAtPct: null };
  assert.match(sellSignal(pos, 1.16, 1000) ?? "", /trailing stop/);
  assert.equal(sellSignal(pos, 1.20, 1000), null);
});

test("holding cap math", () => {
  // token would be 500 of a 1000 vault = 50% > 40% cap -> blocked
  assert.equal(exceedsHoldingCap(500, 1000, 40), true);
  // 300 of 1000 = 30% < 40% -> allowed
  assert.equal(exceedsHoldingCap(300, 1000, 40), false);
  // cap of 0 disables
  assert.equal(exceedsHoldingCap(999, 1000, 0), false);
  // empty vault, nothing to divide -> allow (first buy)
  assert.equal(exceedsHoldingCap(50, 0, 40), false);
});

test("recordBuy opens then blends a position in the database", () => {
  const vault = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  recordBuy({ vault, token, spentPls: 100, tokensOut: parseEther("10"),
    targets: { tpPct: 15, slPct: 20, trailPct: 8, timeExitMin: 0 } });
  recordBuy({ vault, token, spentPls: 200, tokensOut: parseEther("10"),
    targets: { tpPct: 15, slPct: 20, trailPct: 8, timeExitMin: 0 } });

  const rows = db.prepare(
    `SELECT spent_pls, tokens_held, entry_price, tp_pct, sl_pct, trail_pct, status
     FROM positions WHERE vault=? AND token=? AND bot='trading'`,
  ).all(vault, token) as any[];

  assert.equal(rows.length, 1, "second buy should blend, not open a new row");
  assert.equal(rows[0].spent_pls, 300);
  assert.equal(rows[0].entry_price, 15);
  assert.equal(rows[0].tp_pct, 15);
  assert.equal(rows[0].trail_pct, 8);
  assert.equal(rows[0].status, "open");
});
