/**
 * The config shape a vault's bot settings take, shared by the site's API and
 * the keeper (keeper/src/registry.ts). Keep these in sync - the keeper is the
 * ultimate consumer, and a mismatch here would mean the UI saves data the
 * keeper can't read, or shows fields it doesn't respect.
 */

const { CHAIN } = require("./chain");

// minLiquidityPls is denominated in the chain's base unit (PLS or ETH) - the
// field name is kept for shape-compatibility with the keeper. The sensible
// default differs by orders of magnitude between chains, so it comes from the
// chain preset: 2,000,000 PLS-scale vs single-digit ETH-scale.
const DEFAULT_LAUNCH = {
  enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50, stopLossPct: 35,
  trailingStopPct: 0, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
  requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: CHAIN.minLiquidityDefault,
  requireOwnerRenounced: false,
};

const DEFAULT_MAX_HOLDING_PCT = 40;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validates and normalizes one trading rule. Throws with a readable reason on bad input. */
function normalizeRule(r, i) {
  if (typeof r !== "object" || r === null) throw new Error(`rules[${i}] must be an object`);
  if (typeof r.token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.token))
    throw new Error(`rules[${i}].token must be a 0x-address`);
  if (r.direction !== "drops" && r.direction !== "rises")
    throw new Error(`rules[${i}].direction must be "drops" or "rises"`);
  for (const field of ["thresholdPct", "lookbackHours", "allocPct", "cooldownHours", "maxFires"]) {
    if (!isFiniteNumber(r[field]) || r[field] < 0)
      throw new Error(`rules[${i}].${field} must be a non-negative number`);
  }
  if (r.allocPct > 100) throw new Error(`rules[${i}].allocPct cannot exceed 100`);
  for (const field of ["takeProfitPct", "stopLossPct", "trailingStopPct", "timeExitMin"]) {
    if (r[field] !== undefined && r[field] !== null && (!isFiniteNumber(r[field]) || r[field] < 0))
      throw new Error(`rules[${i}].${field} must be a non-negative number if present`);
  }
  return {
    enabled: Boolean(r.enabled),
    token: r.token.toLowerCase(),
    direction: r.direction,
    thresholdPct: r.thresholdPct,
    lookbackHours: r.lookbackHours,
    allocPct: r.allocPct,
    cooldownHours: r.cooldownHours,
    maxFires: r.maxFires,
    takeProfitPct: r.takeProfitPct ?? undefined,
    stopLossPct: r.stopLossPct ?? undefined,
    trailingStopPct: r.trailingStopPct ?? undefined,
    timeExitMin: r.timeExitMin ?? undefined,
  };
}

/** Validates and normalizes one target snipe. Deliberately lighter than a
 * rule: no direction/threshold/lookback, since a snipe isn't reacting to a
 * price move - it's waiting for a specific address to become tradeable. */
function normalizeSnipe(s, i) {
  if (typeof s !== "object" || s === null) throw new Error(`snipes[${i}] must be an object`);
  if (typeof s.token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(s.token))
    throw new Error(`snipes[${i}].token must be a 0x-address`);
  if (!isFiniteNumber(s.amountPls) || s.amountPls < 0)
    throw new Error(`snipes[${i}].amountPls must be a non-negative number`);
  for (const field of ["tpPct", "slPct", "trailingStopPct", "timeExitMin"]) {
    if (s[field] !== undefined && s[field] !== null && (!isFiniteNumber(s[field]) || s[field] < 0))
      throw new Error(`snipes[${i}].${field} must be a non-negative number if present`);
  }
  return {
    enabled: Boolean(s.enabled),
    token: s.token.toLowerCase(),
    amountPls: s.amountPls,
    tpPct: s.tpPct ?? 0,
    slPct: s.slPct ?? 0,
    trailingStopPct: s.trailingStopPct ?? 0,
    timeExitMin: s.timeExitMin ?? 0,
  };
}

/**
 * Validates and normalizes one limit order. Deliberately lighter than a
 * rule or the launch screens - side, a target price, and an amount is the
 * whole shape, since this targets a token the owner already trusts (holds
 * or deposited themselves), not one the bot is discovering and judging.
 */
function normalizeLimitOrder(o, i) {
  if (typeof o !== "object" || o === null) throw new Error(`limitOrders[${i}] must be an object`);
  if (typeof o.id !== "string" || o.id.length === 0)
    throw new Error(`limitOrders[${i}].id is required`);
  if (typeof o.token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.token))
    throw new Error(`limitOrders[${i}].token must be a 0x-address`);
  if (o.side !== "buy" && o.side !== "sell")
    throw new Error(`limitOrders[${i}].side must be "buy" or "sell"`);
  if (!isFiniteNumber(o.targetPrice) || o.targetPrice <= 0)
    throw new Error(`limitOrders[${i}].targetPrice must be a positive number`);
  if (!isFiniteNumber(o.amount) || o.amount < 0)
    throw new Error(`limitOrders[${i}].amount must be a non-negative number`);
  return {
    id: o.id,
    enabled: Boolean(o.enabled),
    token: o.token.toLowerCase(),
    side: o.side,
    targetPrice: o.targetPrice,
    amount: o.amount,
    sellAll: Boolean(o.sellAll),
  };
}

function normalizeLaunch(l) {
  const merged = { ...DEFAULT_LAUNCH, ...(l ?? {}) };
  for (const field of [
    "perLaunchPls", "maxPerDay", "takeProfitPct", "stopLossPct", "trailingStopPct", "timeExitMin",
    "maxBuyTaxBps", "maxSellTaxBps", "maxDeployerPct", "minLiquidityPls",
  ]) {
    if (!isFiniteNumber(merged[field]) || merged[field] < 0)
      throw new Error(`launch.${field} must be a non-negative number`);
  }
  return {
    enabled: Boolean(merged.enabled),
    perLaunchPls: merged.perLaunchPls,
    maxPerDay: merged.maxPerDay,
    takeProfitPct: merged.takeProfitPct,
    stopLossPct: merged.stopLossPct,
    trailingStopPct: merged.trailingStopPct,
    timeExitMin: merged.timeExitMin,
    maxBuyTaxBps: merged.maxBuyTaxBps,
    maxSellTaxBps: merged.maxSellTaxBps,
    requireLpLock: Boolean(merged.requireLpLock),
    maxDeployerPct: merged.maxDeployerPct,
    minLiquidityPls: merged.minLiquidityPls,
    requireOwnerRenounced: Boolean(merged.requireOwnerRenounced),
  };
}

/**
 * Validates a whole config payload as submitted by a user. Throws Error with a
 * human-readable message on the first problem found - callers turn that into
 * a 400 response. Never partially accepts a bad payload.
 */
function normalizeConfig(body) {
  if (typeof body !== "object" || body === null) throw new Error("body must be an object");
  const maxHoldingPct = body.maxHoldingPct ?? DEFAULT_MAX_HOLDING_PCT;
  if (!isFiniteNumber(maxHoldingPct) || maxHoldingPct < 0 || maxHoldingPct > 100)
    throw new Error("maxHoldingPct must be between 0 and 100");
  const rulesIn = Array.isArray(body.rules) ? body.rules : [];
  if (rulesIn.length > 50) throw new Error("too many rules (max 50)");
  const rules = rulesIn.map(normalizeRule);
  const snipesIn = Array.isArray(body.snipes) ? body.snipes : [];
  if (snipesIn.length > 50) throw new Error("too many snipe targets (max 50)");
  const snipes = snipesIn.map(normalizeSnipe);
  const limitOrdersIn = Array.isArray(body.limitOrders) ? body.limitOrders : [];
  if (limitOrdersIn.length > 50) throw new Error("too many limit orders (max 50)");
  const limitOrders = limitOrdersIn.map(normalizeLimitOrder);
  const launch = normalizeLaunch(body.launch);
  return { launch, rules, snipes, limitOrders, maxHoldingPct };
}

function emptyConfig() {
  return {
    launch: { ...DEFAULT_LAUNCH }, rules: [], snipes: [], limitOrders: [],
    maxHoldingPct: DEFAULT_MAX_HOLDING_PCT,
  };
}

module.exports = { normalizeConfig, emptyConfig, DEFAULT_LAUNCH, DEFAULT_MAX_HOLDING_PCT };
