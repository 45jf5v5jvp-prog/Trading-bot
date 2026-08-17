export const EMPTY_RULE = {
  enabled: true, token: "", direction: "drops", thresholdPct: 10, lookbackHours: 24,
  allocPct: 20, cooldownHours: 6, maxFires: 3, takeProfitPct: 15, stopLossPct: 20,
  trailingStopPct: 8, timeExitMin: 0,
};

/** Pure array operations backing the rules editor UI, kept separate from
 * rendering so the indexing logic (the easiest part to get subtly wrong) is
 * directly testable without a DOM. */
export function addRule(rules) {
  return [...rules, { ...EMPTY_RULE }];
}

export function removeRuleAt(rules, index) {
  return rules.filter((_, i) => i !== index);
}

export function updateRuleAt(rules, index, next) {
  return rules.map((r, i) => (i === index ? next : r));
}
