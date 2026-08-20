const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeConfig, emptyConfig } = require("../lib/schema");

test("emptyConfig is safe: launch disabled, no rules, no snipes", () => {
  const c = emptyConfig();
  assert.equal(c.launch.enabled, false);
  assert.deepEqual(c.rules, []);
  assert.deepEqual(c.snipes, []);
  assert.equal(c.maxHoldingPct, 40);
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
