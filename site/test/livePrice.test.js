const test = require("node:test");
const assert = require("node:assert/strict");
const { priceOpenPositions, quotePlsValue, attachRealBalance, _rawQuoteCacheForTests, _marketPriceCacheForTests } = require("../lib/livePrice");

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

// The cross-request raw-quote cache (added so many vault owners' dashboards
// polling at once don't each independently re-quote the same token+amount -
// see cachedRawPlsValue's own comment). This sandbox has no network access,
// so a genuine cache MISS always fails with "no venue could price this
// token" - these tests seed the cache directly (the exported test-only
// _rawQuoteCacheForTests Map) and prove quotePlsValue reads a HIT straight
// back without ever reaching the network, which a real miss could not do.
test("quotePlsValue returns a cached raw quote without touching the network", async () => {
  const token = "0x4444444444444444444444444444444444444444";
  const heldRaw = "5000000000000000000"; // 5 tokens, 18 decimals
  _rawQuoteCacheForTests.set(`${token}:${heldRaw}`, { value: 42, at: Date.now() });
  const value = await quotePlsValue(token, heldRaw); // no vaultAddress - skips fee netting, returns the raw cached value
  assert.equal(value, 42);
});

test("quotePlsValue rethrows a cached failure without touching the network", async () => {
  const token = "0x5555555555555555555555555555555555555555";
  const heldRaw = "1000000000000000000";
  _rawQuoteCacheForTests.set(`${token}:${heldRaw}`, { error: "TEST_SEEDED_ERROR", at: Date.now() });
  await assert.rejects(quotePlsValue(token, heldRaw), /TEST_SEEDED_ERROR/);
});

test("quotePlsValue ignores an expired cache entry and attempts a fresh (here, failing) quote instead", async () => {
  const token = "0x6666666666666666666666666666666666666666";
  const heldRaw = "1000000000000000000";
  // Well past the 12s TTL - a fresh lookup in this network-less sandbox
  // fails with the real "no venue could price" message, distinct from the
  // seeded sentinel, proving the stale entry was NOT what answered this.
  _rawQuoteCacheForTests.set(`${token}:${heldRaw}`, { error: "TEST_SEEDED_ERROR", at: Date.now() - 60_000 });
  await assert.rejects(quotePlsValue(token, heldRaw), /no venue could price this token/);
});

test("different held amounts of the same token are cached separately - never share a size-dependent price", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  _rawQuoteCacheForTests.set(`${token}:1000000000000000000`, { value: 10, at: Date.now() }); // 1 token -> 10 PLS
  _rawQuoteCacheForTests.set(`${token}:9000000000000000000`, { value: 55, at: Date.now() }); // 9 tokens -> 55 PLS (worse per-token, real slippage)
  const small = await quotePlsValue(token, "1000000000000000000");
  const large = await quotePlsValue(token, "9000000000000000000");
  assert.equal(small, 10);
  assert.equal(large, 55);
});

// marketPricePct - the plain "what has the market done since I bought"
// number shown on Current Holdings, deliberately separate from pnlPct
// (which is size/tax/fee-aware - see livePrice.js's own comment on why
// showing that as the headline number confused a vault owner comparing it
// against DexScreener, 2026-08-26). Seeded via the same test-only cache
// seam as the raw-quote tests above.
test("priceOpenPositions attaches marketPricePct computed from a cached market price and the position's entry_price", async () => {
  const token = "0x8888888888888888888888888888888888888888";
  _marketPriceCacheForTests.set(token, { value: 1.5, at: Date.now() }); // market has moved to 1.5 PLS/token
  const result = await priceOpenPositions([
    { id: 1, token, tokens_held: "1000000000000000000", spent_pls: 100, entry_price: 1 }, // bought at 1 PLS/token
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].marketPricePct, 50); // (1.5 - 1) / 1 * 100
});

test("priceOpenPositions leaves marketPricePct null when the position has no entry_price on record", async () => {
  const result = await priceOpenPositions([
    { id: 1, token: "0x2222222222222222222222222222222222222222", tokens_held: "1000000000000000000", spent_pls: 100 },
  ]);
  assert.equal(result[0].marketPricePct, null);
});

test("priceOpenPositions leaves marketPricePct null, without throwing, when the market quote itself fails", async () => {
  // Has a real entry_price so the null-short-circuit above doesn't apply,
  // but no cache seed and no network access in this sandbox - the quote
  // genuinely fails, and that must degrade to null, not blow up the list.
  const result = await priceOpenPositions([
    { id: 1, token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokens_held: "1000000000000000000", spent_pls: 100, entry_price: 1 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].marketPricePct, null);
});

test("marketPricePct is identical for two differently-sized positions in the same token - unlike pnlPct, it is not size-dependent", async () => {
  const token = "0x9999999999999999999999999999999999999999";
  _marketPriceCacheForTests.set(token, { value: 2, at: Date.now() }); // market at 2 PLS/token, regardless of trade size
  const result = await priceOpenPositions([
    { id: 1, token, tokens_held: "1000000000000000000", spent_pls: 100, entry_price: 1 }, // small position
    { id: 2, token, tokens_held: "500000000000000000000", spent_pls: 50000, entry_price: 1 }, // large position, same entry price
  ]);
  assert.equal(result[0].marketPricePct, 100);
  assert.equal(result[1].marketPricePct, 100);
});
