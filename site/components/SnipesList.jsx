import SnipeEditor from "./SnipeEditor";
import { addSnipe, removeSnipeAt, updateSnipeAt } from "../lib/snipesListOps";

/** Target snipes: specific contract addresses to buy the instant they go
 * live, independent of the Launch Bot's own discovery - for a token spotted
 * before its pool exists. */
export default function SnipesList({ snipes, onChange }) {
  return (
    <div>
      {snipes.length === 0 && <p className="hint">No targets yet. Add one to start watching an address.</p>}
      {snipes.map((s, i) => (
        <SnipeEditor
          key={i}
          snipe={s}
          onChange={(next) => onChange(updateSnipeAt(snipes, i, next))}
          onRemove={() => onChange(removeSnipeAt(snipes, i))}
        />
      ))}
      <button type="button" className="btn btn-small" onClick={() => onChange(addSnipe(snipes))}>+ Add Target</button>
    </div>
  );
}
