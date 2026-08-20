const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeConfig, emptyConfig } = require("../lib/schema");

test("emptyConfig is safe: launch disabled, no rules, no snipes", () => {
  const c = emptyConfig();
  assert.equal(c.launch.enabled, false);
  assert.deepEqual(c.rules, []);
  assert.deepEqual(c.snipes, []);
  assert.equal(c.maxHoldingPct, 40);
  assert.equal(c.discovery.enabled, false);
  assert.equal(c.discovery.mode, "notify");
});

test("discovery settings fill in defaults for missing fields, and validate the rest", () => {
  const out = normalizeConfig({ discovery: { enabled: true, mode: "autoBuy", amountPls: 500 } });
  assert.equal(out.discovery.enabled, true);
  assert.equal(out.discovery.mode, "autoBuy");
  assert.equal(out.discovery.amountPls, 500);
  assert.equal(out.discovery.minPriceMovePct, 20); // default filled in
  assert.equal(out.discovery.requireLpLock, true); // default filled in
});

test("rejects a discovery mode that is not notify or autoBuy", () => {
  assert.throws(() => normalizeConfig({ discovery: { mode: "yolo" } }), /mode/);
});

test("rejects a negative discovery threshold", () => {
  assert.throws(() => normalizeConfig({ discovery: { minPriceMovePct: -5 } }), /minPriceMovePct/);
});

test("hunter settings default to off with AI approval required", () => {
  const c = emptyConfig();
  assert.equal(c.hunter.enabled, false);
  assert.equal(c.hunter.mode, "notify");
  assert.equal(c.hunter.requireAiApproval, true);
  assert.equal(c.hunter.minAiConfidence, "medium");
  assert.equal(c.hunter.exitMode, "limited");
});

test("rejects a hunter exitMode that is not limited or full", () => {
  assert.throws(() => normalizeConfig({ hunter: { exitMode: "yolo" } }), /exitMode/);
});

test("accepts exitMode full with a positive stopLossPct", () => {
  const out = normalizeConfig({ hunter: { exitMode: "full", stopLossPct: 30 } });
  assert.equal(out.hunter.exitMode, "full");
  assert.equal(out.hunter.stopLossPct, 30);
});

test("rejects exitMode full with stopLossPct left at 0 - Auto Full still needs a mandatory floor", () => {
  assert.throws(
    () => normalizeConfig({ hunter: { exitMode: "full", stopLossPct: 0 } }),
    /stopLossPct/,
  );
});

test("allows exitMode limited with stopLossPct 0 (a limited-mode owner may legitimately disable it)", () => {
  const out = normalizeConfig({ hunter: { exitMode: "limited", stopLossPct: 0 } });
  assert.equal(out.hunter.stopLossPct, 0);
});

test("hunter settings fill in defaults for missing fields, and validate the rest", () => {
  const out = normalizeConfig({ hunter: { enabled: true, mode: "autoBuy", allocatedPls: 50000, maxPerTradePls: 5000 } });
  assert.equal(out.hunter.enabled, true);
  assert.equal(out.hunter.mode, "autoBuy");
  assert.equal(out.hunter.allocatedPls, 50000);
  assert.equal(out.hunter.maxPerTradePls, 5000);
  assert.equal(out.hunter.rsiOversold, 30); // default filled in
  assert.equal(out.hunter.requireLpLock, true); // default filled in
});

test("rejects a hunter mode that is not notify or autoBuy", () => {
  assert.throws(() => normalizeConfig({ hunter: { mode: "yolo" } }), /mode/);
});

test("rejects a hunter minAiConfidence outside low/medium/high", () => {
  assert.throws(() => normalizeConfig({ hunter: { minAiConfidence: "extreme" } }), /minAiConfidence/);
});

test("rejects a negative hunter threshold", () => {
  assert.throws(() => normalizeConfig({ hunter: { rsiOversold: -5 } }), /rsiOversold/);
});

test("rejects a hunter bollingerPercentBMax outside 0-1", () => {
  assert.throws(() => normalizeConfig({ hunter: { bollingerPercentBMax: 1.5 } }), /bollingerPercentBMax/);
  assert.throws(() => normalizeConfig({ hunter: { bollingerPercentBMax: -0.1 } }), /bollingerPercentBMax/);
});

test("rejects a hunter maxPerTradePls larger than its own allocatedPls", () => {
  assert.throws(
    () => normalizeConfig({ hunter: { allocatedPls: 1000, maxPerTradePls: 5000 } }),
    /maxPerTradePls/,
  );
});

test("allows hunter maxPerTradePls larger than allocatedPls when allocatedPls is 0 (still disabled)", () => {
  const out = normalizeConfig({ hunter: { allocatedPls: 0, maxPerTradePls: 5000 } });
  assert.equal(out.hunter.maxPerTradePls, 5000);
});

test("accepts a minimal valid snipe target", () => {
  const out = normalizeConfig({
    snipes: [{ enabled: true, token: "0x" + "2".repeat(40), amountPls: 1000 }],
  });
  assert.equal(out.snipes.length, 1);
  assert.equal(out.snipes[0].token, "0x" + "2".repeat(40));
  assert.equal(out.snipes[0].amountPls, 1000);
  assert.equal(out.snipes[0].tpPct, 0); // default filled in
});

test("rejects a snipe with a bad token address", () => {
  assert.throws(() => normalizeConfig({
    snipes: [{ enabled: true, token: "not-an-address", amountPls: 100 }],
  }), /token/);
});

test("rejects a snipe with a negative amount", () => {
  assert.throws(() => normalizeConfig({
    snipes: [{ enabled: true, token: "0x" + "2".repeat(40), amountPls: -5 }],
  }), /amountPls/);
});

test("rejects more than 50 snipe targets (sanity cap)", () => {
  const snipes = Array.from({ length: 51 }, () => ({
    enabled: true, token: "0x" + "2".repeat(40), amountPls: 100,
  }));
  assert.throws(() => normalizeConfig({ snipes }), /too many snipe targets/);
});

test("accepts a minimal valid limit order", () => {
  const out = normalizeConfig({
    limitOrders: [{ id: "abc", enabled: true, token: "0x" + "3".repeat(40), side: "sell", targetPrice: 0.005, amount: 0, sellAll: true }],
  });
  assert.equal(out.limitOrders.length, 1);
  assert.equal(out.limitOrders[0].side, "sell");
  assert.equal(out.limitOrders[0].sellAll, true);
});

test("rejects a limit order missing an id", () => {
  assert.throws(() => normalizeConfig({
    limitOrders: [{ enabled: true, token: "0x" + "3".repeat(40), side: "sell", targetPrice: 0.005, amount: 0 }],
  }), /id/);
});

test("rejects a limit order with a bad side", () => {
  assert.throws(() => normalizeConfig({
    limitOrders: [{ id: "abc", enabled: true, token: "0x" + "3".repeat(40), side: "sideways", targetPrice: 0.005, amount: 0 }],
  }), /side/);
});

test("rejects a limit order with a non-positive target price", () => {
  assert.throws(() => normalizeConfig({
    limitOrders: [{ id: "abc", enabled: true, token: "0x" + "3".repeat(40), side: "buy", targetPrice: 0, amount: 10 }],
  }), /targetPrice/);
});

test("accepts a minimal valid config with one rule", () => {
  const out = normalizeConfig({
    maxHoldingPct: 30,
    launch: { enabled: false },
    rules: [{
      enabled: true, token: "0x" + "1".repeat(40), direction: "drops",
      thresholdPct: 10, lookbackHours: 24, allocPct: 20, cooldownHours: 6, maxFires: 3,
      takeProfitPct: 15, stopLossPct: 20, trailingStopPct: 8, timeExitMin: 0,
    }],
  });
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].token, "0x" + "1".repeat(40));
  assert.equal(out.maxHoldingPct, 30);
});

test("rejects a rule with a bad token address", () => {
  assert.throws(() => normalizeConfig({
    rules: [{ enabled: true, token: "not-an-address", direction: "drops",
      thresholdPct: 1, lookbackHours: 1, allocPct: 1, cooldownHours: 1, maxFires: 1 }],
  }), /token/);
});

test("rejects an invalid direction", () => {
  assert.throws(() => normalizeConfig({
    rules: [{ enabled: true, token: "0x" + "1".repeat(40), direction: "sideways",
      thresholdPct: 1, lookbackHours: 1, allocPct: 1, cooldownHours: 1, maxFires: 1 }],
  }), /direction/);
});

test("rejects allocPct over 100", () => {
  assert.throws(() => normalizeConfig({
    rules: [{ enabled: true, token: "0x" + "1".repeat(40), direction: "drops",
      thresholdPct: 1, lookbackHours: 1, allocPct: 150, cooldownHours: 1, maxFires: 1 }],
  }), /allocPct/);
});

test("rejects negative numbers", () => {
  assert.throws(() => normalizeConfig({
    rules: [{ enabled: true, token: "0x" + "1".repeat(40), direction: "drops",
      thresholdPct: -5, lookbackHours: 1, allocPct: 1, cooldownHours: 1, maxFires: 1 }],
  }), /thresholdPct/);
});

test("rejects maxHoldingPct out of 0-100 range", () => {
  assert.throws(() => normalizeConfig({ maxHoldingPct: 150 }), /maxHoldingPct/);
  assert.throws(() => normalizeConfig({ maxHoldingPct: -1 }), /maxHoldingPct/);
});

test("rejects more than 50 rules (sanity cap)", () => {
  const rules = Array.from({ length: 51 }, () => ({
    enabled: true, token: "0x" + "1".repeat(40), direction: "drops",
    thresholdPct: 1, lookbackHours: 1, allocPct: 1, cooldownHours: 1, maxFires: 1,
  }));
  assert.throws(() => normalizeConfig({ rules }), /too many rules/);
});

test("launch settings fill in defaults for missing fields, and validate the rest", () => {
  const out = normalizeConfig({ launch: { enabled: true, perLaunchPls: 5000 } });
  assert.equal(out.launch.enabled, true);
  assert.equal(out.launch.perLaunchPls, 5000);
  assert.equal(out.launch.maxPerDay, 4); // default filled in
  assert.equal(out.launch.requireLpLock, true); // default filled in
});

test("rejects a non-object body", () => {
  assert.throws(() => normalizeConfig(null));
  assert.throws(() => normalizeConfig("nope"));
});

test("token addresses are normalized to lowercase", () => {
  const out = normalizeConfig({
    rules: [{ enabled: true, token: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12", direction: "rises",
      thresholdPct: 1, lookbackHours: 1, allocPct: 1, cooldownHours: 1, maxFires: 1 }],
  });
  assert.equal(out.rules[0].token, "0xabcdef1234567890abcdef1234567890abcdef12");
});
