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

// Discovery Bot: watches every token the keeper has ever seen for a price
// move and a liquidity increase happening together over a fixed 60-minute
// window, instead of reacting to one token the user named (a rule/limit
// order) or a token being brand new (Launch Bot). Deployer-share is
// deliberately absent here - see keeper/src/registry.ts's DiscoveryConfig
// comment for why.
const DEFAULT_DISCOVERY = {
  enabled: false, mode: "notify", amountPls: 0, maxPerDay: 4,
  minPriceMovePct: 20, minLiquidityGrowthPct: 15, minLiquidityPls: CHAIN.minLiquidityDefault,
  takeProfitPct: 50, stopLossPct: 35, trailingStopPct: 0, timeExitMin: 60,
  maxBuyTaxBps: 1000, maxSellTaxBps: 1000, requireLpLock: true, requireOwnerRenounced: false,
  // Which Quick Setup wizard answer produced the fields above, if any - kept
  // for shape-compatibility with any vault's already-saved config even
  // though Discovery Bot's own settings UI (formerly components/
  // DiscoverySettings.jsx) was removed along with the bot itself - the
  // keeper never runs discovery.tick() anymore (see keeper/src/index.ts),
  // so this section is inert, not read as bot behavior.
  quickSetupStyle: null, quickSetupRisk: null, quickSetupSize: null,
};

// Historical preset keys DEFAULT_DISCOVERY's quickSetup* fields could hold,
// from Discovery Bot's now-removed settings UI - kept only so an old saved
// config still normalizes without error.
const QUICK_SETUP_STYLE_KEYS = ["frequent", "balanced", "patient"];
const QUICK_SETUP_RISK_KEYS = ["tight", "moderate", "loose"];
const QUICK_SETUP_SIZE_KEYS = ["small", "medium", "large"];

// Hunter Bot: hunts RSI/MACD/Bollinger dip-buying setups across every
// watched token, trading a dedicated slice of the vault (allocatedPls)
// rather than the whole balance - see keeper/src/registry.ts's
// HunterConfig comment for the full reasoning, including the
// liquidity-coherence check (always on, not a setting here) that catches a
// price crash caused by a liquidity pull before it's mistaken for a dip.
const DEFAULT_HUNTER = {
  enabled: false, mode: "notify", allocatedPls: 0, allocatedUnlimited: false, maxPerTradePls: 0, maxPerDay: 3,
  exitMode: "limited",
  requireRsi: true, rsiOversold: 30, requireMacdCross: true,
  requireBollinger: true, bollingerPercentBMax: 0.15,
  minLiquidityPls: CHAIN.minLiquidityDefault, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
  requireLpLock: true, requireOwnerRenounced: false,
  requireAiApproval: true, minAiConfidence: "medium",
  takeProfitPct: 40, stopLossPct: 25, useAtrStop: false, atrStopMultiplier: 3,
  trailingStopPct: 0, timeExitMin: 0,
  requireVolumeConfirmation: false, minVolumeRatio: 1.5,
  minTrades24h: 0,
  autoRebuyOnExit: false, autoRebuyDipPct: 15, autoRebuyExpireHours: 48,
  maxOpenPositions: 0,
};

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
  const takeProfitPct = o.takeProfitPct ?? 0;
  const stopLossPct = o.stopLossPct ?? 0;
  if (!isFiniteNumber(takeProfitPct) || takeProfitPct < 0)
    throw new Error(`limitOrders[${i}].takeProfitPct must be a non-negative number`);
  if (!isFiniteNumber(stopLossPct) || stopLossPct < 0)
    throw new Error(`limitOrders[${i}].stopLossPct must be a non-negative number`);
  return {
    id: o.id,
    enabled: Boolean(o.enabled),
    token: o.token.toLowerCase(),
    side: o.side,
    targetPrice: o.targetPrice,
    amount: o.amount,
    sellAll: Boolean(o.sellAll),
    takeProfitPct,
    stopLossPct,
  };
}

function normalizeDiscovery(d) {
  const merged = { ...DEFAULT_DISCOVERY, ...(d ?? {}) };
  if (merged.mode !== "notify" && merged.mode !== "autoBuy")
    throw new Error(`discovery.mode must be "notify" or "autoBuy"`);
  for (const field of [
    "amountPls", "maxPerDay", "minPriceMovePct", "minLiquidityGrowthPct", "minLiquidityPls",
    "takeProfitPct", "stopLossPct", "trailingStopPct", "timeExitMin", "maxBuyTaxBps", "maxSellTaxBps",
  ]) {
    if (!isFiniteNumber(merged[field]) || merged[field] < 0)
      throw new Error(`discovery.${field} must be a non-negative number`);
  }
  if (merged.quickSetupStyle !== null && !QUICK_SETUP_STYLE_KEYS.includes(merged.quickSetupStyle))
    throw new Error(`discovery.quickSetupStyle must be one of ${QUICK_SETUP_STYLE_KEYS.join(", ")}, or null`);
  if (merged.quickSetupRisk !== null && !QUICK_SETUP_RISK_KEYS.includes(merged.quickSetupRisk))
    throw new Error(`discovery.quickSetupRisk must be one of ${QUICK_SETUP_RISK_KEYS.join(", ")}, or null`);
  if (merged.quickSetupSize !== null && !QUICK_SETUP_SIZE_KEYS.includes(merged.quickSetupSize))
    throw new Error(`discovery.quickSetupSize must be one of ${QUICK_SETUP_SIZE_KEYS.join(", ")}, or null`);
  return {
    enabled: Boolean(merged.enabled),
    mode: merged.mode,
    amountPls: merged.amountPls,
    maxPerDay: merged.maxPerDay,
    minPriceMovePct: merged.minPriceMovePct,
    minLiquidityGrowthPct: merged.minLiquidityGrowthPct,
    minLiquidityPls: merged.minLiquidityPls,
    takeProfitPct: merged.takeProfitPct,
    stopLossPct: merged.stopLossPct,
    trailingStopPct: merged.trailingStopPct,
    timeExitMin: merged.timeExitMin,
    maxBuyTaxBps: merged.maxBuyTaxBps,
    maxSellTaxBps: merged.maxSellTaxBps,
    requireLpLock: Boolean(merged.requireLpLock),
    requireOwnerRenounced: Boolean(merged.requireOwnerRenounced),
    quickSetupStyle: merged.quickSetupStyle,
    quickSetupRisk: merged.quickSetupRisk,
    quickSetupSize: merged.quickSetupSize,
  };
}

function normalizeHunter(h) {
  const merged = { ...DEFAULT_HUNTER, ...(h ?? {}) };
  if (merged.mode !== "notify" && merged.mode !== "autoBuy")
    throw new Error(`hunter.mode must be "notify" or "autoBuy"`);
  if (merged.exitMode !== "limited" && merged.exitMode !== "full")
    throw new Error(`hunter.exitMode must be "limited" or "full"`);
  if (merged.minAiConfidence !== "low" && merged.minAiConfidence !== "medium" && merged.minAiConfidence !== "high")
    throw new Error(`hunter.minAiConfidence must be "low", "medium", or "high"`);
  for (const field of [
    "allocatedPls", "maxPerTradePls", "maxPerDay", "rsiOversold", "minLiquidityPls",
    "takeProfitPct", "stopLossPct", "trailingStopPct", "timeExitMin", "maxBuyTaxBps", "maxSellTaxBps",
    "atrStopMultiplier", "minVolumeRatio", "minTrades24h",
    "autoRebuyDipPct", "autoRebuyExpireHours", "maxOpenPositions",
  ]) {
    if (!isFiniteNumber(merged[field]) || merged[field] < 0)
      throw new Error(`hunter.${field} must be a non-negative number`);
  }
  if (!isFiniteNumber(merged.bollingerPercentBMax) || merged.bollingerPercentBMax < 0 || merged.bollingerPercentBMax > 1)
    throw new Error("hunter.bollingerPercentBMax must be between 0 and 1");
  if (!merged.allocatedUnlimited && merged.maxPerTradePls > merged.allocatedPls && merged.allocatedPls > 0)
    throw new Error("hunter.maxPerTradePls cannot exceed hunter.allocatedPls");
  // Auto Full hands the AI ongoing exit authority - the stop-loss is the one
  // thing that authority can never remove, so it must be a real number here,
  // not left at the "disabled" 0 a limited-mode owner might reasonably use.
  // useAtrStop still needs a real flat stopLossPct too - it's the fallback
  // whenever ATR wasn't available at buy time (see keeper/src/hunter.ts's
  // computeStopLossPct), so Auto Full can't be left with nothing either way.
  if (merged.exitMode === "full" && merged.stopLossPct <= 0)
    throw new Error("hunter.stopLossPct must be greater than 0 when exitMode is \"full\" - Auto Full still needs a mandatory stop-loss");
  if (merged.useAtrStop && merged.atrStopMultiplier <= 0)
    throw new Error("hunter.atrStopMultiplier must be greater than 0 when useAtrStop is on");
  if (merged.autoRebuyDipPct >= 100)
    throw new Error("hunter.autoRebuyDipPct must be less than 100");
  return {
    enabled: Boolean(merged.enabled),
    mode: merged.mode,
    allocatedPls: merged.allocatedPls,
    allocatedUnlimited: Boolean(merged.allocatedUnlimited),
    maxPerTradePls: merged.maxPerTradePls,
    maxPerDay: merged.maxPerDay,
    exitMode: merged.exitMode,
    requireRsi: Boolean(merged.requireRsi),
    rsiOversold: merged.rsiOversold,
    requireMacdCross: Boolean(merged.requireMacdCross),
    requireBollinger: Boolean(merged.requireBollinger),
    bollingerPercentBMax: merged.bollingerPercentBMax,
    minLiquidityPls: merged.minLiquidityPls,
    maxBuyTaxBps: merged.maxBuyTaxBps,
    maxSellTaxBps: merged.maxSellTaxBps,
    requireLpLock: Boolean(merged.requireLpLock),
    requireOwnerRenounced: Boolean(merged.requireOwnerRenounced),
    requireAiApproval: Boolean(merged.requireAiApproval),
    minAiConfidence: merged.minAiConfidence,
    takeProfitPct: merged.takeProfitPct,
    stopLossPct: merged.stopLossPct,
    useAtrStop: Boolean(merged.useAtrStop),
    atrStopMultiplier: merged.atrStopMultiplier,
    trailingStopPct: merged.trailingStopPct,
    timeExitMin: merged.timeExitMin,
    requireVolumeConfirmation: Boolean(merged.requireVolumeConfirmation),
    minVolumeRatio: merged.minVolumeRatio,
    minTrades24h: merged.minTrades24h,
    autoRebuyOnExit: Boolean(merged.autoRebuyOnExit),
    autoRebuyDipPct: merged.autoRebuyDipPct,
    autoRebuyExpireHours: merged.autoRebuyExpireHours,
    maxOpenPositions: merged.maxOpenPositions,
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
  const discovery = normalizeDiscovery(body.discovery);
  const hunter = normalizeHunter(body.hunter);
  return { launch, rules, snipes, limitOrders, discovery, hunter, maxHoldingPct };
}

function emptyConfig() {
  return {
    launch: { ...DEFAULT_LAUNCH }, rules: [], snipes: [], limitOrders: [],
    discovery: { ...DEFAULT_DISCOVERY }, hunter: { ...DEFAULT_HUNTER }, maxHoldingPct: DEFAULT_MAX_HOLDING_PCT,
  };
}

module.exports = {
  normalizeConfig, emptyConfig, DEFAULT_LAUNCH, DEFAULT_DISCOVERY, DEFAULT_HUNTER, DEFAULT_MAX_HOLDING_PCT,
};
