const test = require("node:test");
const assert = require("node:assert/strict");
const { priceOpenPositions, quotePlsValue, attachRealBalance } = require("../lib/livePrice");

test("quotePlsValue returns 0 for a fully-exited position without touching the network", async () => {
  const value = await quotePlsValue("0x1111111111111111111111111111111111111111", "0");
  assert.equal(value, 0);
});

test("priceOpenPositions is a no-op on an empty list", async () => {
  const result = await priceOpenPositions([]);
  assert.deepEqual(result, []);
});

test("priceOpenPositions marks a position as unpriceable (nulls, no throw) when the quote fails", async () => {
  // No network access in this sandbox and no live liquidity for a made-up
  // token, so this real call is expected to fail - priceOpenPositions should
  // absorb that per-position rather than throwing for the whole list.
  const result = await priceOpenPositions([
    { id: 1, token: "0x2222222222222222222222222222222222222222", tokens_held: "1000000000000000000", spent_pls: 100 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].valueNowPls, null);
  assert.equal(result[0].pnlPct, null);
});

test("attachRealBalance is a no-op on an empty list", async () => {
  const result = await attachRealBalance([], "0x3333333333333333333333333333333333333333");
  assert.deepEqual(result, []);
});

test("attachRealBalance leaves non-stuck positions untouched, no hasRealBalance field added", async () => {
  const result = await attachRealBalance(
    [{ id: 1, status: "closed", token: "0x2222222222222222222222222222222222222222" }],
    "0x3333333333333333333333333333333333333333",
  );
  assert.equal(result.length, 1);
  assert.equal("hasRealBalance" in result[0], false);
});

test("attachRealBalance marks a stuck position's balance as null (not false) when the check itself fails", async () => {
  // No network access in this sandbox, so the real balanceOf call is
  // expected to fail - that must never be reported as a confirmed-empty
  // balance (false), only as "couldn't check" (null).
  const result = await attachRealBalance(
    [{ id: 1, status: "stuck", token: "0x2222222222222222222222222222222222222222" }],
    "0x3333333333333333333333333333333333333333",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].hasRealBalance, null);
});
