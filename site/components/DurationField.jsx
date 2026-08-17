import { useState } from "react";

function toDisplay(hours, unit) {
  const n = Number(hours) || 0;
  const v = unit === "minutes" ? n * 60 : n;
  return Math.round(v * 100) / 100;
}

function toHours(displayValue, unit) {
  const n = displayValue === "" ? 0 : Number(displayValue);
  if (!Number.isFinite(n)) return 0;
  return unit === "minutes" ? n / 60 : n;
}

/**
 * A numeric input for a duration that's stored (and sent to the keeper)
 * in hours - the schema/keeper contract doesn't change - but lets the user
 * type in whichever unit reads more naturally. "15" minutes for a
 * fast-reacting rule beats typing "0.25" hours; "24" hours beats "1440"
 * minutes for a slow one. The unit toggle is purely a display choice:
 * onChange always reports a value in hours, same as before this existed.
 */
export default function DurationField({ hours, onChange, style }) {
  const [unit, setUnit] = useState(hours > 0 && hours < 1 ? "minutes" : "hours");
  const [raw, setRaw] = useState(String(toDisplay(hours, unit)));

  function handleNumberChange(value) {
    setRaw(value);
    if (value !== "") onChange(toHours(value, unit));
  }

  function handleUnitChange(nextUnit) {
    if (nextUnit === unit) return;
    setUnit(nextUnit);
    setRaw(String(toDisplay(hours, nextUnit)));
  }

  return (
    <span className="row" style={{ gap: 6, display: "inline-flex", ...style }}>
      <input
        type="number"
        value={raw}
        onFocus={(e) => e.target.select()}
        onChange={(e) => handleNumberChange(e.target.value)}
        onBlur={() => { if (raw === "") handleNumberChange("0"); }}
        min="0"
        style={{ width: 70 }}
      />
      <select value={unit} onChange={(e) => handleUnitChange(e.target.value)} style={{ width: 88 }}>
        <option value="hours">hours</option>
        <option value="minutes">minutes</option>
      </select>
    </span>
  );
}
