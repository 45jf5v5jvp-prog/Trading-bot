import RuleEditor from "./RuleEditor";
import { addRule, removeRuleAt, updateRuleAt } from "../lib/rulesListOps";

/** The list of independent trading rules a vault runs - what the original
 * design called "bots": each rule is its own watch-a-token, buy-the-dip (or
 * top), sell-on-target unit, running side by side with the others. */
export default function RulesList({ rules, onChange }) {
  return (
    <div>
      <div className="section-label">Trading Bots</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Each one watches a single token and buys the dip (or the top) on its own - add as many as you want.
      </p>
      {rules.length === 0 && <p className="hint">No bots yet. Add one to start.</p>}
      {rules.map((r, i) => (
        <RuleEditor
          key={i}
          rule={r}
          onChange={(next) => onChange(updateRuleAt(rules, i, next))}
          onRemove={() => onChange(removeRuleAt(rules, i))}
        />
      ))}
      <button type="button" className="btn btn-small" onClick={() => onChange(addRule(rules))}>+ Add New Bot</button>
    </div>
  );
}
