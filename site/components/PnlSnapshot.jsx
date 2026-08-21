import { useState } from "react";
import { CHAIN } from "../lib/contracts";
import { pnlForWindow } from "../lib/pnl";

const WINDOWS = [
  { key: "1h", label: "1H", hours: 1 },
  { key: "6h", label: "6H", hours: 6 },
  { key: "24h", label: "24H", hours: 24 },
  { key: "all", label: "All", hours: null },
];

function fmtPls(v, unit) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals })} ${unit}`;
}

function pnlClass(v) {
  if (v > 0.000001) return "pnl-pos";
  if (v < -0.000001) return "pnl-neg";
  return "pnl-flat";
}

/** Window-selectable P&L rollup - 1H/6H/24H/All buttons above the running
 * total from trades opened or closed in that window. All time is the
 * headline: how the bot has actually done since the vault started, not just
 * whatever happened recently. */
export default function PnlSnapshot({ history }) {
  const [windowKey, setWindowKey] = useState("all");
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
        <p className="hint">
          {w.hours === null ? "No trades yet." : `No trades opened or closed in the last ${w.label.toLowerCase()}.`}
        </p>
      ) : (
        <>
          <div className={`num ${pnlClass(totalPls)}`} style={{ fontSize: 34, fontWeight: 700 }}>{fmtPls(totalPls, unit)}</div>
          <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
            {fmtPls(realizedPls, unit)} realized, {fmtPls(unrealizedPls, unit)} unrealized, from {tradeCount}{" "}
            {tradeCount === 1 ? "position" : "positions"}{w.hours === null ? " overall" : ` opened or closed in the last ${w.label.toLowerCase()}`}.
          </p>
        </>
      )}
    </div>
  );
}
