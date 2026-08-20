import test from "node:test";
import assert from "node:assert/strict";

// See ai.test.ts for why this is a separate file: CFG reads
// ANTHROPIC_API_KEY once at import time, so the key must be set before
// anything in this file imports config.ts (transitively, via ai.ts).
process.env.ANTHROPIC_API_KEY = "test-key";

process.env.DB_PATH = "/tmp/claude-0/-home-user-Trading-bot/3123e22c-cef8-5b8c-874f-df7176e2f79c/scratchpad/ai-with-key-test.db";
import { existsSync, rmSync } from "node:fs";
for (const p of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"])
  if (existsSync(p)) rmSync(p);

const { assess, answerQuestion } = await import("../src/ai.js");

const baseProfile = {
  symbol: "TEST", token: "0x1111111111111111111111111111111111111111",
  liqPls: 2_000_000, buyTaxBps: 100, sellTaxBps: 100, lpLockedPct: 99,
  deployerPct: null, ownerRenounced: true, roundTripLossBps: 50,
  priceMovePct: 25, liqGrowthPct: 20, rsi: 28, macdHistogram: 0.4,
  macdBullishCross: true, bollingerPercentB: 0.1,
};

function mockFetch(impl: () => Promise<any>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return () => { globalThis.fetch = original; };
}

test("assess() parses a well-formed give_verdict tool call", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_verdict", input: { recommend: true, confidence: "medium", reasoning: "Looks fine." } }],
    }),
  }));
  try {
    const v = await assess(baseProfile as any);
    assert.deepEqual(v, { recommend: true, confidence: "medium", reasoning: "Looks fine." });
  } finally { restore(); }
});

test("assess() falls back to low confidence on an unrecognized confidence value", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_verdict", input: { recommend: false, confidence: "extreme", reasoning: "Weird value." } }],
    }),
  }));
  try {
    const v = await assess(baseProfile as any);
    assert.equal(v?.confidence, "low");
  } finally { restore(); }
});

test("assess() returns null rather than guessing when the tool call is missing", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "I refuse to use the tool." }] }),
  }));
  try {
    const v = await assess(baseProfile as any);
    assert.equal(v, null);
  } finally { restore(); }
});

test("assess() returns null on a non-ok HTTP response rather than throwing", async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 401, text: async () => "unauthorized" }));
  try {
    const v = await assess(baseProfile as any);
    assert.equal(v, null);
  } finally { restore(); }
});

test("assess() returns null when fetch itself rejects (network failure)", async () => {
  const restore = mockFetch(async () => { throw new Error("ECONNRESET"); });
  try {
    const v = await assess(baseProfile as any);
    assert.equal(v, null);
  } finally { restore(); }
});

test("answerQuestion() returns the model's text block", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "This looks reasonable but watch the tax." }] }),
  }));
  try {
    const v = await answerQuestion(baseProfile as any, "should I buy this?");
    assert.equal(v, "This looks reasonable but watch the tax.");
  } finally { restore(); }
});
