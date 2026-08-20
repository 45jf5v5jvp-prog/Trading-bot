function newOrderId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID (older browsers) -
  // only needs to be unique within one vault's order list, not globally.
  return `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function emptyLimitOrder() {
  return {
    id: newOrderId(), enabled: true, token: "", side: "sell",
    targetPrice: 0, amount: 0, sellAll: true,
  };
}

/** Pure array operations backing the limit order editor UI, same shape as
 * snipesListOps.js/rulesListOps.js. */
export function addLimitOrder(orders) {
  return [...orders, emptyLimitOrder()];
}

export function removeLimitOrderAt(orders, index) {
  return orders.filter((_, i) => i !== index);
}

export function updateLimitOrderAt(orders, index, next) {
  return orders.map((o, i) => (i === index ? next : o));
}
