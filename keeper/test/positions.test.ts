import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";

// Use a throwaway database, same pattern as portfolio.test.ts. Must be set
// before importing anything that pulls in config/db.
process.env.DB_PATH = "/tmp/claude-0/-home-user-Trading-bot/3123e22c-cef8-5b8c-874f-df7176e2f79c/scratchpad/positions-test.db";
import { existsSync, rmSync } from "node:fs";
for (const p of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"])
  if (existsSync(p)) rmSync(p);

const { openPosition, hasStuckHistory } = await import("../src/positions.js");
const { db } = await import("../src/db.js");

const VAULT_A = "0x" + "1".repeat(40);
const VAULT_B = "0x" + "2".repeat(40);
const STUCK_TOKEN = "0x" + "a".repeat(40);
const CLEAN_TOKEN = "0x" + "b".repeat(40);

test("hasStuckHistory is false for a token with no positions at all", () => {
  assert.equal(hasStuckHistory("0x" + "9".repeat(40)), false);
});

test("hasStuckHistory is false for a token whose only positions are open/closed, never stuck", () => {
  openPosition({
    vault: VAULT_A, bot: "hunter", token: CLEAN_TOKEN,
    spentPls: 100, tokensOut: parseEther("10"),
    tpPct: 20, slPct: 15, timeExitMin: 0,
  });
  assert.equal(hasStuckHistory(CLEAN_TOKEN), false);
});

test("hasStuckHistory is true once ANY vault has a stuck position on this token, even a different vault than the one asking", () => {
  openPosition({
    vault: VAULT_B, bot: "hunter", token: STUCK_TOKEN,
    spentPls: 100000, tokensOut: parseEther("1"),
    tpPct: 40, slPct: 15, timeExitMin: 0,
  });
  db.prepare(`UPDATE positions SET status='stuck', close_reason=? WHERE vault=? AND token=?`)
    .run("cannot sell", VAULT_B.toLowerCase(), STUCK_TOKEN.toLowerCase());

  // hasStuckHistory takes no vault - a stuck position on VAULT_B protects
  // every vault, including VAULT_A, which never touched this token.
  assert.equal(hasStuckHistory(STUCK_TOKEN), true);
  // Case-insensitive, same convention as every other token lookup here.
  assert.equal(hasStuckHistory(STUCK_TOKEN.toUpperCase()), true);
});

test("hasStuckHistory stays true even after the row would be hidden from the dashboard (never deleted)", () => {
  // Mirrors the site's confirmed-empty stuck-position filtering (v3.37.0) -
  // that only hides the row from the UI, it never deletes it, so this guard
  // keeps working on a token whose stuck row is no longer shown anywhere.
  const row = db.prepare(`SELECT status FROM positions WHERE vault=? AND token=?`)
    .get(VAULT_B.toLowerCase(), STUCK_TOKEN.toLowerCase()) as { status: string };
  assert.equal(row.status, "stuck");
  assert.equal(hasStuckHistory(STUCK_TOKEN), true);
});
