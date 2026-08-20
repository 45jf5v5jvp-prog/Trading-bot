import { useState } from "react";
import { CHAIN } from "../lib/contracts";

const WINDOWS = [
  { key: "6h", label: "6H", hours: 6 },
  { key: "12h", label: "12H", hours: 12 },
  { key: "24h", label: "24H", hours: 24 },
];

/**
 * P&L attributable to trading ACTIVITY within the window - realized gains
 * from positions that closed in it, plus the current unrealized gain/loss
 * on positions opened in it and still open. Deliberately not "vault value
 * now minus vault value N hours ago": that would need periodic value
 * snapshots this repo doesn't keep, and would silently be wrong on a fresh
 * vault with no snapshot history yet. This is honestly computable from data
 * already on the dashboard (positions.open/closed from /api/.../history),
 * and answers the question people actually have - "how has the bot done
 * lately" - without pretending to a precision the data doesn't support.
 */
function pnlForWindow(history, hours) {
  const cutoffSec = Math.floor(Date.now() / 1000) - hours * 3600;
  let realizedPls = 0;
  let unrealizedPls = 0;
  let closedCount = 0;
  let openCount = 0;

  for (const p of history.positions.closed) {
    if (p.closed_at >= cutoffSec && p.proceeds_pls !== null && p.proceeds_pls !== undefined) {
      realizedPls += p.proceeds_pls - p.spent_pls;
      closedCount++;
    }
  }
  for (const p of history.positions.open) {
    if (p.opened_at >= cutoffSec && p.valueNowPls !== null && p.valueNowPls !== undefined) {
      unrealizedPls += p.valueNowPls - p.spent_pls;
      openCount++;
    }
  }

  return { realizedPls, unrealizedPls, totalPls: realizedPls + unrealizedPls, tradeCount: closedCount + openCount };
}

function fmtPls(v, unit) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals })} ${unit}`;
}

function pnlClass(v) {
  if (v > 0.000001) return "pnl-pos";
  if (v < -0.000001) return "pnl-neg";
  return "pnl-flat";
}

/** Window-selectable P&L rollup - 6H/12H/24H buttons above the running
 * total from trades opened or closed in that window. */
export default function PnlSnapshot({ history }) {
  const [windowKey, setWindowKey] = useState("24h");
  if (!history) return null;

  const w = WINDOWS.find((x) => x.key === windowKey);
  const { realizedPls, unrealizedPls, totalPls, tradeCount } = pnlForWindow(history, w.hours);
  const unit = CHAIN.nativeSymbol;

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>P&amp;L Snapshot</div>
        <div className="row" style={{ gap: 6 }}>
          {WINDOWS.map((x) => (
            <button
              key={x.key}
              type="button"
              className={windowKey === x.key ? "btn btn-small btn-primary" : "btn btn-small"}
              onClick={() => setWindowKey(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {tradeCount === 0 ? (
        <p className="hint">No trades opened or closed in the last {w.label.toLowerCase()}.</p>
      ) : (
        <>
          <div className={`num ${pnlClass(totalPls)}`} style={{ fontSize: 26 }}>{fmtPls(totalPls, unit)}</div>
          <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
            {fmtPls(realizedPls, unit)} realized, {fmtPls(unrealizedPls, unit)} unrealized, from {tradeCount}{" "}
            {tradeCount === 1 ? "position" : "positions"} opened or closed in the last {w.label.toLowerCase()}.
          </p>
        </>
      )}
    </div>
  );
}
