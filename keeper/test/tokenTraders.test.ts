import test from "node:test";
import assert from "node:assert/strict";

// Use a throwaway database, same pattern as positions.test.ts/portfolio.test.ts.
// Must be set before importing anything that pulls in config/db.
process.env.DB_PATH = "/tmp/claude-0/-home-user-Trading-bot/3123e22c-cef8-5b8c-874f-df7176e2f79c/scratchpad/token-traders-test.db";
import { existsSync, rmSync } from "node:fs";
for (const p of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"])
  if (existsSync(p)) rmSync(p);

const { tokenTraders } = await import("../src/db.js");

const TOKEN = "0x" + "a".repeat(40);
const OTHER_TOKEN = "0x" + "b".repeat(40);
const WALLET_1 = "0x" + "1".repeat(40);
const WALLET_2 = "0x" + "2".repeat(40);
const WALLET_3 = "0x" + "3".repeat(40);

const NOW = 1_000_000;
const DAY_AGO = NOW - 86400;

test("count is 0 for a token with no recorded trades at all", () => {
  assert.equal(tokenTraders.count(TOKEN, DAY_AGO), 0);
});

test("count reflects DISTINCT wallets, not raw rows - the same wallet trading many times still counts once", () => {
  tokenTraders.record(TOKEN, WALLET_1, NOW - 100);
  tokenTraders.record(TOKEN, WALLET_1, NOW - 90);
  tokenTraders.record(TOKEN, WALLET_1, NOW - 80);
  // 3 rows, same wallet - a raw trade count would see 3, this must see 1.
  assert.equal(tokenTraders.count(TOKEN, DAY_AGO), 1);
});

test("count grows as genuinely different wallets trade", () => {
  tokenTraders.record(TOKEN, WALLET_2, NOW - 70);
  tokenTraders.record(TOKEN, WALLET_3, NOW - 60);
  assert.equal(tokenTraders.count(TOKEN, DAY_AGO), 3);
});

test("record is case-insensitive on both token and address, same convention as every other token/address lookup here", () => {
  assert.equal(tokenTraders.count(TOKEN.toUpperCase(), DAY_AGO), 3);
  tokenTraders.record(TOKEN, WALLET_1.toUpperCase(), NOW - 50);
  // Same wallet, different case - still just the 3 distinct wallets.
  assert.equal(tokenTraders.count(TOKEN, DAY_AGO), 3);
});

test("count is scoped to the token asked about - another token's traders don't leak in", () => {
  tokenTraders.record(OTHER_TOKEN, WALLET_1, NOW - 40);
  assert.equal(tokenTraders.count(OTHER_TOKEN, DAY_AGO), 1);
  assert.equal(tokenTraders.count(TOKEN, DAY_AGO), 3);
});

test("count excludes rows older than the requested window", () => {
  const oldToken = "0x" + "c".repeat(40);
  tokenTraders.record(oldToken, WALLET_1, NOW - 2 * 86400); // 2 days ago
  assert.equal(tokenTraders.count(oldToken, DAY_AGO), 0);
});

test("prune removes rows before the cutoff, leaving newer ones intact", () => {
  const pruneToken = "0x" + "d".repeat(40);
  tokenTraders.record(pruneToken, WALLET_1, NOW - 3 * 86400); // old, should be pruned
  tokenTraders.record(pruneToken, WALLET_2, NOW - 100); // recent, should survive
  tokenTraders.prune(NOW - 2 * 86400);
  assert.equal(tokenTraders.count(pruneToken, NOW - 30 * 86400), 1);
});
