import { numberFieldProps } from "../lib/numberField";

/**
 * Editor for one trading rule. Pure/controlled - all state lives in the
 * parent so saving is one explicit action, not a signed transaction per
 * keystroke.
 */
export default function RuleEditor({ rule, onChange, onRemove }) {
  const set = (field) => (e) => onChange({ ...rule, [field]: e.target.value });
  const num = (field) => numberFieldProps(rule[field] ?? 0, (v) => onChange({ ...rule, [field]: v }));

  return (
    <div className="rule-panel">
      <div className="rule-panel-header">
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={rule.enabled} onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} />
          {rule.enabled ? "This bot is ON — it will act automatically" : "This bot is OFF — saved but not active"}
        </label>
        <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>Remove</button>
      </div>

      <div className="field">
        <label>Token address</label>
        <input value={rule.token} onChange={set("token")} style={{ width: "100%" }} />
      </div>

      <div className="field-inline">
        <label>Direction</label>
        <select value={rule.direction} onChange={set("direction")}>
          <option value="drops">drops</option>
          <option value="rises">rises</option>
        </select>
      </div>

      <div className="field-inline">
        <label>Threshold %</label>
        <input {...num("thresholdPct")} min="0" style={{ width: 80 }} />
        <label>over hours</label>
        <input {...num("lookbackHours")} min="0" style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Allocate % of vault per trade</label>
        <input {...num("allocPct")} min="0" max="100" style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Cooldown hours</label>
        <input {...num("cooldownHours")} min="0" style={{ width: 80 }} />
        <label>Max fires/day</label>
        <input {...num("maxFires")} min="0" style={{ width: 80 }} />
      </div>

      <div className="sub-label">Sell targets (leave 0 to disable)</div>

      <div className="field-inline">
        <label>Take profit %</label>
        <input {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
        <label>Stop loss %</label>
        <input {...num("stopLossPct")} min="0" style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Trailing stop %</label>
        <input {...num("trailingStopPct")} min="0" style={{ width: 80 }} />
        <label>Time exit (min)</label>
        <input {...num("timeExitMin")} min="0" style={{ width: 80 }} />
      </div>
    </div>
  );
}
