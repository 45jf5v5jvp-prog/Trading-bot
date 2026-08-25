const test = require("node:test");
const assert = require("node:assert/strict");
const { openPositionsValue, fmtEstimate } = require("../lib/accountValue");

test("openPositionsValue is null for missing history (still loading)", () => {
  assert.equal(openPositionsValue(null), null);
});

test("openPositionsValue is zero-valued for a vault with no open positions", () => {
  const r = openPositionsValue({ positions: { open: [], closed: [] } });
  assert.deepEqual(r, { valuePls: 0, count: 0, unpriced: 0 });
});

test("openPositionsValue sums valueNowPls across every open position, any bot", () => {
  const history = {
    positions: {
      open: [
        { bot: "hunter", valueNowPls: 1000 },
        { bot: "launch", valueNowPls: 2500 },
        { bot: "trading", valueNowPls: 0 },
      ],
      closed: [],
    },
  };
  const r = openPositionsValue(history);
  assert.equal(r.valuePls, 3500);
  assert.equal(r.count, 3);
  assert.equal(r.unpriced, 0);
});

test("openPositionsValue counts a null/undefined valueNowPls as unpriced, contributing 0 - never a guess", () => {
  const history = {
    positions: {
      open: [
        { bot: "hunter", valueNowPls: 1000 },
        { bot: "hunter", valueNowPls: null }, // no liquidity to price right now
        { bot: "hunter", valueNowPls: undefined },
      ],
      closed: [],
    },
  };
  const r = openPositionsValue(history);
  assert.equal(r.valuePls, 1000);
  assert.equal(r.count, 3);
  assert.equal(r.unpriced, 2);
});

test("fmtEstimate rounds normally, does not floor like the vault balance display", () => {
  assert.equal(fmtEstimate(1234.5678, 2), "1,234.57");
  assert.equal(fmtEstimate(0.0000001, 2), "0");
});

test("fmtEstimate passes through a non-finite value unchanged rather than showing NaN", () => {
  assert.equal(fmtEstimate(undefined, 2), undefined);
  assert.equal(fmtEstimate("not a number", 2), "not a number");
});

test("fmtEstimate treats null as 0, same as Number(null) - never a crash", () => {
  assert.equal(fmtEstimate(null, 2), "0");
});
