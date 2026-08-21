import { numberFieldProps } from "../lib/numberField";
import NumberField from "./NumberField";
import { CHAIN } from "../lib/contracts";

/**
 * Editor for one target snipe - a specific contract address to buy the
 * instant it becomes tradeable, not a token the bot discovers on its own.
 * Same controlled/pure shape as RuleEditor.
 */
export default function SnipeEditor({ snipe, onChange, onRemove }) {
  const num = (field) => numberFieldProps(snipe[field] ?? 0, (v) => onChange({ ...snipe, [field]: v }));

  return (
    <div className="rule-panel">
      <div className="rule-panel-header">
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={snipe.enabled} onChange={(e) => onChange({ ...snipe, enabled: e.target.checked })} />
          {snipe.enabled ? "Armed — buys the moment this address is tradeable" : "Off — saved but not watching"}
        </label>
        <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>Remove</button>
      </div>

      <div className="field">
        <label>Token contract address</label>
        <input
          value={snipe.token}
          onChange={(e) => onChange({ ...snipe, token: e.target.value })}
          placeholder="0x..."
          style={{ width: "100%" }}
        />
      </div>

      <div className="field-inline">
        <label>{CHAIN.nativeSymbol} to spend</label>
        <NumberField {...num("amountPls")} min="0" style={{ width: 110 }} />
      </div>
      <p className="hint" style={{ marginTop: -4 }}>
        Checked every few seconds. Fires once, the moment this address has a real pool to trade
        against - buying works, selling works, and the round trip doesn't lose too much. Skips the
        Launch Bot's other screens (age, creator share, liquidity floor) since you already chose
        this token yourself.
      </p>

      <div className="sub-label">Sell targets (leave 0 to disable)</div>

      <div className="field-inline">
        <label>Take profit %</label>
        <NumberField {...num("tpPct")} min="0" style={{ width: 80 }} />
        <label>Stop loss %</label>
        <NumberField {...num("slPct")} min="0" style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Trailing stop %</label>
        <NumberField {...num("trailingStopPct")} min="0" style={{ width: 80 }} />
        <label>Time exit (min)</label>
        <NumberField {...num("timeExitMin")} min="0" style={{ width: 80 }} />
      </div>
    </div>
  );
}
