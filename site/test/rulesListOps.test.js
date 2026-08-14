const test = require("node:test");
const assert = require("node:assert/strict");
const { addRule, removeRuleAt, updateRuleAt, EMPTY_RULE } = require("../lib/rulesListOps");

test("addRule appends a fresh rule without mutating the original array", () => {
  const original = [{ token: "0xaaa" }];
  const result = addRule(original);
  assert.equal(original.length, 1, "original array must not be mutated");
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], EMPTY_RULE);
  assert.notEqual(result[1], EMPTY_RULE, "must be a copy, not a shared reference");
});

test("removeRuleAt removes exactly the item at that index, nothing else", () => {
  const rules = [{ token: "0xa" }, { token: "0xb" }, { token: "0xc" }];
  const result = removeRuleAt(rules, 1);
  assert.deepEqual(result, [{ token: "0xa" }, { token: "0xc" }]);
  assert.equal(rules.length, 3, "original must not be mutated");
});

test("removeRuleAt at index 0 removes the first item", () => {
  const rules = [{ token: "0xa" }, { token: "0xb" }];
  assert.deepEqual(removeRuleAt(rules, 0), [{ token: "0xb" }]);
});

test("removeRuleAt at the last index removes the last item", () => {
  const rules = [{ token: "0xa" }, { token: "0xb" }];
  assert.deepEqual(removeRuleAt(rules, 1), [{ token: "0xa" }]);
});

test("removeRuleAt with an out-of-range index is a no-op (removes nothing)", () => {
  const rules = [{ token: "0xa" }];
  assert.deepEqual(removeRuleAt(rules, 5), rules);
});

test("updateRuleAt replaces only the targeted item, in place order", () => {
  const rules = [{ token: "0xa", allocPct: 10 }, { token: "0xb", allocPct: 20 }];
  const result = updateRuleAt(rules, 1, { token: "0xb", allocPct: 99 });
  assert.deepEqual(result, [{ token: "0xa", allocPct: 10 }, { token: "0xb", allocPct: 99 }]);
  assert.equal(rules[1].allocPct, 20, "original must not be mutated");
});

test("add then remove then update composes correctly (simulates real UI usage)", () => {
  let rules = [];
  rules = addRule(rules);                              // [EMPTY_RULE]
  rules = addRule(rules);                               // [EMPTY_RULE, EMPTY_RULE]
  rules = updateRuleAt(rules, 0, { ...rules[0], token: "0xfirst" });
  rules = updateRuleAt(rules, 1, { ...rules[1], token: "0xsecond" });
  assert.equal(rules[0].token, "0xfirst");
  assert.equal(rules[1].token, "0xsecond");
  rules = removeRuleAt(rules, 0);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].token, "0xsecond", "removing index 0 must leave the SECOND rule behind, not the first");
});
