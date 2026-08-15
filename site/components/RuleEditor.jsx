/**
 * Editor for one trading rule. Pure/controlled - all state lives in the
 * parent so saving is one explicit action, not a signed transaction per
 * keystroke.
 */
export default function RuleEditor({ rule, onChange, onRemove }) {
  const set = (field) => (e) => {
    const raw = e.target.value;
    const numericFields = ["thresholdPct", "lookbackHours", "allocPct", "cooldownHours", "maxFires",
      "takeProfitPct", "stopLossPct", "trailingStopPct", "timeExitMin"];
    onChange({ ...rule, [field]: numericFields.includes(field) ? Number(raw) : raw });
  };

  return (
    <div className="rule-panel">
      <div className="rule-panel-header">
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={rule.enabled} onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} />
          Enabled
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
        <input type="number" min="0" value={rule.thresholdPct} onChange={set("thresholdPct")} style={{ width: 80 }} />
        <label>over hours</label>
        <input type="number" min="0" value={rule.lookbackHours} onChange={set("lookbackHours")} style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Allocate % of vault per trade</label>
        <input type="number" min="0" max="100" value={rule.allocPct} onChange={set("allocPct")} style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Cooldown hours</label>
        <input type="number" min="0" value={rule.cooldownHours} onChange={set("cooldownHours")} style={{ width: 80 }} />
        <label>Max fires/day</label>
        <input type="number" min="0" value={rule.maxFires} onChange={set("maxFires")} style={{ width: 80 }} />
      </div>

      <div className="sub-label">Sell targets (leave 0 to disable)</div>

      <div className="field-inline">
        <label>Take profit %</label>
        <input type="number" min="0" value={rule.takeProfitPct ?? 0} onChange={set("takeProfitPct")} style={{ width: 80 }} />
        <label>Stop loss %</label>
        <input type="number" min="0" value={rule.stopLossPct ?? 0} onChange={set("stopLossPct")} style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Trailing stop %</label>
        <input type="number" min="0" value={rule.trailingStopPct ?? 0} onChange={set("trailingStopPct")} style={{ width: 80 }} />
        <label>Time exit (min)</label>
        <input type="number" min="0" value={rule.timeExitMin ?? 0} onChange={set("timeExitMin")} style={{ width: 80 }} />
      </div>
    </div>
  );
}
