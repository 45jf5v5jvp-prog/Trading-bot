import RuleEditor from "./RuleEditor";
import { addRule, removeRuleAt, updateRuleAt } from "../lib/rulesListOps";

/** The list of independent trading rules a vault runs - what the original
 * design called "bots": each rule is its own watch-a-token, buy-the-dip (or
 * top), sell-on-target unit, running side by side with the others. */
export default function RulesList({ rules, onChange }) {
  return (
    <div>
      <h2>Trading Rules</h2>
      {rules.length === 0 && <p>No rules yet. Add one to start.</p>}
      {rules.map((r, i) => (
        <RuleEditor
          key={i}
          rule={r}
          onChange={(next) => onChange(updateRuleAt(rules, i, next))}
          onRemove={() => onChange(removeRuleAt(rules, i))}
        />
      ))}
      <button type="button" onClick={() => onChange(addRule(rules))}>+ Add Rule</button>
    </div>
  );
}
