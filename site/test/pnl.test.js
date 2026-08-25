const test = require("node:test");
const assert = require("node:assert/strict");
const { pnlForWindow } = require("../lib/pnl");

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

test("finite window sums realized/unrealized from positions.closed/open within the cutoff", () => {
  const history = {
    positions: {
      closed: [
        { bot: "hunter", closed_at: NOW - HOUR, proceeds_pls: 150, spent_pls: 100 }, // in window, +50
        { bot: "hunter", closed_at: NOW - 30 * HOUR, proceeds_pls: 999, spent_pls: 1 }, // outside window
      ],
      open: [
        { bot: "hunter", opened_at: NOW - HOUR, valueNowPls: 120, spent_pls: 100 }, // in window, +20
      ],
    },
    lifetime: [],
  };
  const r = pnlForWindow(history, 24, "hunter");
  assert.equal(r.realizedPls, 50);
  assert.equal(r.unrealizedPls, 20);
  assert.equal(r.closedCount, 1);
  assert.equal(r.tradeCount, 2);
});

// The actual bug found live (2026-08-24): positions.closed is capped at the
// vault's 100 most recently opened positions (see keeperDb.js's
// getPositions), so an "all time" total naively summed from it silently
// drops real, older trades for a fast-trading vault. hours: null must read
// from history.lifetime (an unbounded aggregate) instead - this fixture
// simulates exactly that: a closed list missing an old trade that only
// shows up in `lifetime`.
test("hours: null (lifetime) reads from history.lifetime, not the capped positions.closed list", () => {
  const history = {
    positions: {
      // Only the vault's most recent 100 positions would really be here -
      // this fixture stands in for that cap by simply omitting an old
      // trade entirely, the same way the real capped list would.
      closed: [
        { bot: "hunter", closed_at: NOW - HOUR, proceeds_pls: 150, spent_pls: 100 },
      ],
      open: [
        { bot: "hunter", opened_at: NOW - HOUR, valueNowPls: 120, spent_pls: 100 },
      ],
    },
    // The true, unbounded total - includes the old trade positions.closed
    // above doesn't have room for.
    lifetime: [
      { bot: "hunter", closedCount: 38, realizedPls: 125360 },
      { bot: "launch", closedCount: 5, realizedPls: 900 },
    ],
  };
  const r = pnlForWindow(history, null, "hunter");
  assert.equal(r.closedCount, 38);
  assert.equal(r.realizedPls, 125360);
  // Unrealized/open count still comes from positions.open, not lifetime -
  // open positions aren't the part of this bug that was broken.
  assert.equal(r.unrealizedPls, 20);
  assert.equal(r.tradeCount, 38 + 1);
});

test("hours: null with no botFilter sums every bot's lifetime row", () => {
  const history = {
    positions: { closed: [], open: [] },
    lifetime: [
      { bot: "hunter", closedCount: 38, realizedPls: 125360 },
      { bot: "launch", closedCount: 5, realizedPls: 900 },
    ],
  };
  const r = pnlForWindow(history, null);
  assert.equal(r.closedCount, 43);
  assert.equal(r.realizedPls, 126260);
});

test("hours: null with an empty/missing lifetime array is 0, not a crash", () => {
  const history = { positions: { closed: [], open: [] } }; // no `lifetime` key at all
  const r = pnlForWindow(history, null, "hunter");
  assert.equal(r.realizedPls, 0);
  assert.equal(r.closedCount, 0);
  assert.equal(r.tradeCount, 0);
});
