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

const { assess, answerQuestion, assessExit, reflectOnLoss, reflectOnMiss } = await import("../src/ai.js");

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

test("assess() clamps suggestedAmountPls to the given ceiling, even if the model ignores the instruction", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_verdict", input: { recommend: true, confidence: "high", reasoning: "Strong.", suggestedAmountPls: 999_999 } }],
    }),
  }));
  try {
    const v = await assess(baseProfile as any, 1000);
    assert.equal(v?.suggestedAmountPls, 1000);
  } finally { restore(); }
});

test("assess() passes through a suggestedAmountPls within the ceiling unchanged", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_verdict", input: { recommend: true, confidence: "low", reasoning: "Cautious.", suggestedAmountPls: 250 } }],
    }),
  }));
  try {
    const v = await assess(baseProfile as any, 1000);
    assert.equal(v?.suggestedAmountPls, 250);
  } finally { restore(); }
});

test("assess() has no suggestedAmountPls field when called with no ceiling", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_verdict", input: { recommend: true, confidence: "medium", reasoning: "Fine.", suggestedAmountPls: 500 } }],
    }),
  }));
  try {
    const v = await assess(baseProfile as any);
    assert.equal(v?.suggestedAmountPls, undefined);
  } finally { restore(); }
});

test("assessExit() parses a well-formed give_exit_verdict tool call", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_exit_verdict", input: { sell: true, reasoning: "RSI overbought, taking the win." } }],
    }),
  }));
  try {
    const v = await assessExit(basePosition as any);
    assert.deepEqual(v, { sell: true, reasoning: "RSI overbought, taking the win." });
  } finally { restore(); }
});

test("assessExit() returns null rather than guessing when the tool call is missing", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "I refuse to use the tool." }] }),
  }));
  try {
    const v = await assessExit(basePosition as any);
    assert.equal(v, null);
  } finally { restore(); }
});

test("assessExit() returns null on a non-ok HTTP response rather than throwing", async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 500, text: async () => "server error" }));
  try {
    const v = await assessExit(basePosition as any);
    assert.equal(v, null);
  } finally { restore(); }
});

test("assess() with guidance includes each lesson in the prompt sent to Claude, oldest first", async () => {
  let capturedBody: any = null;
  const restore = mockFetch(async (_url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        content: [{ type: "tool_use", name: "give_verdict", input: { recommend: true, confidence: "medium", reasoning: "Fine." } }],
      }),
    };
  });
  try {
    await assess(baseProfile as any, undefined, ["Skip anything under 5M PLS liquidity.", "Weight RSI more than MACD."]);
    const prompt = capturedBody.messages[0].content as string;
    assert.match(prompt, /Skip anything under 5M PLS liquidity\./);
    assert.match(prompt, /Weight RSI more than MACD\./);
    assert.ok(prompt.indexOf("Skip anything") < prompt.indexOf("Weight RSI"), "guidance must appear oldest-first");
  } finally { restore(); }
});

test("assess() with no guidance omits the coaching section entirely (unchanged prompt for a vault with no lessons)", async () => {
  let capturedBody: any = null;
  const restore = mockFetch(async (_url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        content: [{ type: "tool_use", name: "give_verdict", input: { recommend: true, confidence: "medium", reasoning: "Fine." } }],
      }),
    };
  });
  try {
    await assess(baseProfile as any);
    const prompt = capturedBody.messages[0].content as string;
    assert.doesNotMatch(prompt, /coaching this bot/);
  } finally { restore(); }
});

test("reflectOnLoss() parses a well-formed give_lesson tool call", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_lesson", input: { lesson: "The RSI signal was real but liquidity was too thin to hold through the dip." } }],
    }),
  }));
  try {
    const lesson = await reflectOnLoss({
      symbol: "TEST", token: "0x1111111111111111111111111111111111111111",
      buyNarrative: "TEST looks oversold: RSI 25.", closeReason: "stop loss 25%", pnlPct: -25, heldMinutes: 40,
    });
    assert.equal(lesson, "The RSI signal was real but liquidity was too thin to hold through the dip.");
  } finally { restore(); }
});

test("reflectOnLoss() returns null rather than guessing when the tool call is missing", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "I refuse to use the tool." }] }),
  }));
  try {
    const lesson = await reflectOnLoss({
      symbol: "TEST", token: "0x1111111111111111111111111111111111111111",
      buyNarrative: "narrative", closeReason: "stop loss", pnlPct: -20, heldMinutes: 10,
    });
    assert.equal(lesson, null);
  } finally { restore(); }
});

test("reflectOnMiss() parses a well-formed give_lesson tool call", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "give_lesson", input: { lesson: "Low AI confidence on a passing screen was too cautious here - weight the mechanical screen more." } }],
    }),
  }));
  try {
    const lesson = await reflectOnMiss({
      symbol: "TEST", token: "0x1111111111111111111111111111111111111111",
      detectionNarrative: "TEST looks oversold: RSI 25.", declineReason: "low confidence",
      movePctSinceDeclined: 80, daysSinceDeclined: 3,
    });
    assert.equal(lesson, "Low AI confidence on a passing screen was too cautious here - weight the mechanical screen more.");
  } finally { restore(); }
});
