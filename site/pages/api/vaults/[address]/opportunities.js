const { getOpportunities, getDiscoveryActionsForVault } = require("../../../../lib/keeperDb");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/vaults/:address/opportunities - public read, same reasoning as
 * portfolio/history: nothing sensitive in a list of tokens that pumped.
 * Discovery Bot's findings are global (one scanner, shared across every
 * vault), so this reads the keeper's own opportunities table directly and
 * layers on just this vault's own notified/bought status, so the dashboard
 * can grey out a Buy Now button already acted on.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();
  const actions = getDiscoveryActionsForVault(vault);
  const opportunities = getOpportunities().map((o) => ({
    id: o.id,
    token: o.token,
    ts: o.ts,
    priceMovePct: o.price_move_pct,
    liqGrowthPct: o.liq_growth_pct,
    liqPls: o.liq_pls,
    buyTaxBps: o.buy_tax_bps,
    sellTaxBps: o.sell_tax_bps,
    lpLockedPct: o.lp_locked_pct,
    ownerRenounced: o.owner_renounced === null ? null : Boolean(o.owner_renounced),
    sellable: Boolean(o.sellable),
    verdict: o.verdict,
    reason: o.reason,
    narrative: o.narrative,
    source: o.source ?? "discovery",
    rsi: o.rsi ?? null,
    macdHistogram: o.macd_histogram ?? null,
    bollingerPercentB: o.bollinger_percent_b ?? null,
    aiRecommend: o.ai_recommend === null || o.ai_recommend === undefined ? null : Boolean(o.ai_recommend),
    aiConfidence: o.ai_confidence ?? null,
    aiReasoning: o.ai_reasoning ?? null,
    aiSuggestedAmountPls: o.ai_suggested_amount_pls ?? null,
    action: actions[o.id]?.action ?? null,
    txHash: actions[o.id]?.txHash ?? null,
  }));
  res.status(200).json({ opportunities });
}
