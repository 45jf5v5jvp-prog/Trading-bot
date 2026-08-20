export const EMPTY_SNIPE = {
  enabled: true, token: "", amountPls: 0,
  tpPct: 50, slPct: 35, trailingStopPct: 0, timeExitMin: 30,
};

/** Pure array operations backing the snipe list editor UI, same shape as
 * rulesListOps.js - kept separate from rendering so indexing bugs are
 * directly testable without a DOM. */
export function addSnipe(snipes) {
  return [...snipes, { ...EMPTY_SNIPE }];
}

export function removeSnipeAt(snipes, index) {
  return snipes.filter((_, i) => i !== index);
}

export function updateSnipeAt(snipes, index, next) {
  return snipes.map((s, i) => (i === index ? next : s));
}
