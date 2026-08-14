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
    <fieldset style={{ marginBottom: 12, padding: 12 }}>
      <label>
        <input type="checkbox" checked={rule.enabled} onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} />
        {" "}Enabled
      </label>
      <button type="button" onClick={onRemove} style={{ float: "right" }}>Remove</button>

      <div>
        <label>Token address: <input value={rule.token} onChange={set("token")} size={44} /></label>
      </div>
      <div>
        <label>
          Direction:{" "}
          <select value={rule.direction} onChange={set("direction")}>
            <option value="drops">drops</option>
            <option value="rises">rises</option>
          </select>
        </label>
      </div>
      <div>
        <label>Threshold %: <input type="number" min="0" value={rule.thresholdPct} onChange={set("thresholdPct")} /></label>
        {" "}
        <label>over hours: <input type="number" min="0" value={rule.lookbackHours} onChange={set("lookbackHours")} /></label>
      </div>
      <div>
        <label>Allocate % of vault per trade: <input type="number" min="0" max="100" value={rule.allocPct} onChange={set("allocPct")} /></label>
      </div>
      <div>
        <label>Cooldown hours: <input type="number" min="0" value={rule.cooldownHours} onChange={set("cooldownHours")} /></label>
        {" "}
        <label>Max fires/day: <input type="number" min="0" value={rule.maxFires} onChange={set("maxFires")} /></label>
      </div>
      <div>
        <em>Sell targets (leave 0 to disable):</em>
      </div>
      <div>
        <label>Take profit %: <input type="number" min="0" value={rule.takeProfitPct ?? 0} onChange={set("takeProfitPct")} /></label>
        {" "}
        <label>Stop loss %: <input type="number" min="0" value={rule.stopLossPct ?? 0} onChange={set("stopLossPct")} /></label>
      </div>
      <div>
        <label>Trailing stop %: <input type="number" min="0" value={rule.trailingStopPct ?? 0} onChange={set("trailingStopPct")} /></label>
        {" "}
        <label>Time exit (min): <input type="number" min="0" value={rule.timeExitMin ?? 0} onChange={set("timeExitMin")} /></label>
      </div>
    </fieldset>
  );
}
