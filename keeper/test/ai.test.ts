import test from "node:test";
import assert from "node:assert/strict";

// CFG (config.ts) reads process.env once at import time and is a singleton
// for the life of this process, same as every other test file in this repo
// relies on for DB_PATH etc. So "no key" and "key present" behavior are
// split into separate test files (ai.test.ts / ai-with-key.test.ts) rather
// than toggling the env var mid-file, which CFG would never see.
delete process.env.ANTHROPIC_API_KEY;

process.env.DB_PATH = "/tmp/claude-0/-home-user-Trading-bot/3123e22c-cef8-5b8c-874f-df7176e2f79c/scratchpad/ai-test.db";
import { existsSync, rmSync } from "node:fs";
for (const p of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"])
  if (existsSync(p)) rmSync(p);

const { assess, answerQuestion, assessExit } = await import("../src/ai.js");

const baseProfile = {
  symbol: "TEST", token: "0x1111111111111111111111111111111111111111",
  liqPls: 2_000_000, buyTaxBps: 100, sellTaxBps: 100, lpLockedPct: 99,
  deployerPct: null, ownerRenounced: true, roundTripLossBps: 50,
  priceMovePct: 25, liqGrowthPct: 20, rsi: 28, macdHistogram: 0.4,
  macdBullishCross: true, bollingerPercentB: 0.1, atrPct: 12.5, volRatio: 1.8,
};

const basePosition = {
  symbol: "TEST", token: "0x1111111111111111111111111111111111111111",
  entryPrice: 1, currentPrice: 1.5, pnlPct: 50, peakPnlPct: 60, minutesHeld: 90,
  rsi: 65, macdHistogram: 0.1, macdBullishCross: false, macdBearishCross: false, bollingerPercentB: 0.8,
  atrPct: 9, volRatio: 1.2,
};

test("assess() returns null with no API key set, never a fabricated approval", async () => {
  const v = await assess(baseProfile as any);
  assert.equal(v, null);
});

test("answerQuestion() returns null with no API key set", async () => {
  const v = await answerQuestion(baseProfile as any, "is this safe?");
  assert.equal(v, null);
});

test("assessExit() returns null with no API key set, never a fabricated sell signal", async () => {
  const v = await assessExit(basePosition as any);
  assert.equal(v, null);
});
