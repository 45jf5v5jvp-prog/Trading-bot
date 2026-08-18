/**
 * The config shape a vault's bot settings take, shared by the site's API and
 * the keeper (keeper/src/registry.ts). Keep these in sync - the keeper is the
 * ultimate consumer, and a mismatch here would mean the UI saves data the
 * keeper can't read, or shows fields it doesn't respect.
 */

const DEFAULT_LAUNCH = {
  enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50, stopLossPct: 35,
  timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000, requireLpLock: true,
  maxDeployerPct: 15, minLiquidityPls: 2_000_000, requireOwnerRenounced: false,
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

function normalizeLaunch(l) {
  const merged = { ...DEFAULT_LAUNCH, ...(l ?? {}) };
  for (const field of [
    "perLaunchPls", "maxPerDay", "takeProfitPct", "stopLossPct", "timeExitMin",
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
  const launch = normalizeLaunch(body.launch);
  return { launch, rules, maxHoldingPct };
}

function emptyConfig() {
  return { launch: { ...DEFAULT_LAUNCH }, rules: [], maxHoldingPct: DEFAULT_MAX_HOLDING_PCT };
}

module.exports = { normalizeConfig, emptyConfig, DEFAULT_LAUNCH, DEFAULT_MAX_HOLDING_PCT };
