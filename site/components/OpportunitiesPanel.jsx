import { CHAIN } from "../lib/contracts";

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtTs(unixSeconds) {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const CONFIDENCE_COLOR = { high: "var(--green, #2e7d32)", medium: "#b8860b", low: "var(--red, #c0392b)" };

/**
 * One opportunity Discovery Bot or Hunter Bot found and screened. A failed
 * screen is still shown - "this pumped but looks like a trap" (or "this
 * looked oversold but liquidity looks pulled") is useful even when it isn't
 * buyable - but only a passed one ever gets a Buy Now button. `action` is
 * this vault's own status for it ("notified", "bought", or none yet), read
 * from the keeper's discovery_actions table.
 */
function OpportunityRow({ o, onBuy, buyState }) {
  const passed = o.verdict === "pass";
  const busy = buyState === "pending";
  const bought = o.action === "bought" || buyState === "requested";
  const isHunter = o.source === "hunter";

  return (
    <div className="row-between dead-position-row">
      <div>
        <div className="row" style={{ gap: 8 }}>
          <span className="holding-token" style={{ fontSize: 12.5 }}>{short(o.token)}</span>
          <span
            className="hint"
            style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 10 }}
          >
            {isHunter ? "Hunter" : "Discovery"}
          </span>
          <span className="hint" style={{ margin: 0 }}>{fmtTs(o.ts)}</span>
          {!passed && <span style={{ color: "var(--red, #c0392b)", fontSize: 12 }}>screen failed</span>}
        </div>
        <p className="hint" style={{ margin: "4px 0 0" }}>{o.narrative}</p>
        {o.aiConfidence && (
          <p className="hint" style={{ margin: "4px 0 0", color: CONFIDENCE_COLOR[o.aiConfidence] }}>
            AI: {o.aiRecommend ? "would buy" : "would not buy"} ({o.aiConfidence} confidence)
            {o.aiRecommend && o.aiSuggestedAmountPls
              ? ` — sizing this at ${Math.round(o.aiSuggestedAmountPls).toLocaleString()} ${CHAIN.nativeSymbol}`
              : ""}
          </p>
        )}
      </div>
      {passed && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onBuy(o.id)}
          disabled={busy || bought}
        >
          {busy ? "..." : bought ? "Bought" : "Buy Now"}
        </button>
      )}
    </div>
  );
}

/**
 * Discovery Bot's and Hunter Bot's findings, one shared feed - global across
 * every vault, since each scanner runs once and screens once per token (see
 * keeper/src/discovery.ts, keeper/src/hunter.ts). Buy Now signs and submits
 * a request the keeper picks up on its next pass; it spends whatever the
 * vault's own bot's "amount per buy" setting is for that opportunity's
 * source, same as an auto-buy would.
 */
export default function OpportunitiesPanel({ opportunities, onBuy, buyStates }) {
  return (
    <div>
      <div className="section-label">Opportunities</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Tokens on {CHAIN.dexName} that Discovery Bot spotted moving (price and liquidity climbing
        together) or Hunter Bot spotted looking oversold (RSI/MACD/Bollinger). Turn either one on
        above to start seeing new ones.
      </p>
      {(!opportunities || opportunities.length === 0) && (
        <p className="hint">Nothing found yet. This fills in as Discovery Bot or Hunter Bot runs.</p>
      )}
      {opportunities?.map((o) => (
        <OpportunityRow key={o.id} o={o} onBuy={onBuy} buyState={buyStates?.[o.id]} />
      ))}
    </div>
  );
}
