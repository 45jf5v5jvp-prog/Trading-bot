import { useState, useEffect, useRef } from "react";

/** Keeps only digits and at most one decimal point - everything else typed
 * (letters, a second ".", pasted commas) is silently dropped rather than
 * rejected, so pasting an already-formatted "1,000,000" still works. */
function stripToNumeric(s) {
  let out = "";
  let seenDot = false;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !seenDot) { out += ch; seenDot = true; }
  }
  return out;
}

function groupThousands(numericStr) {
  if (numericStr === "") return "";
  const [intPart, decPart] = numericStr.split(".");
  const grouped = intPart === "" ? "0" : Number(intPart).toLocaleString("en-US");
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

/**
 * A comma-formatted numeric input - "1000000" reads as "1,000,000" while
 * typing, since a wall of digits with no separators is easy to misread or
 * fat-finger an extra zero into. `value`/`onChange` behave exactly like a
 * plain number input did before this existed (see lib/numberField.js's
 * numberFieldProps): the field can hold "" while being cleared out rather
 * than snapping back to 0 on every keystroke, and an empty field commits to
 * 0 on blur. Keeps its own display buffer while focused so a trailing
 * decimal point ("1234.") or trailing zero ("1234.50") mid-edit isn't
 * stripped out from under the person still typing it.
 *
 * `asString`: report the cleaned digit string to onChange instead of a JS
 * Number. Use this for anything that flows straight into parseEther (a
 * deposit/withdraw amount, say) - a wallet balance can carry more
 * significant digits than a double preserves exactly, and rounding a wei
 * amount before it reaches parseEther is a real, if small, money bug.
 */
export default function NumberField({ value, onChange, asString = false, ...rest }) {
  const [raw, setRaw] = useState(() => groupThousands(value === "" || value == null ? "" : String(value)));
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setRaw(groupThousands(value === "" || value == null ? "" : String(value)));
  }, [value]);

  function handleChange(e) {
    const numeric = stripToNumeric(e.target.value);
    setRaw(groupThousands(numeric));
    if (numeric === "" || numeric === ".") onChange("");
    else onChange(asString ? numeric : Number(numeric));
  }

  function handleBlur() {
    focused.current = false;
    if (raw === "") {
      onChange(asString ? "0" : 0);
      setRaw("0");
      return;
    }
    const cleaned = stripToNumeric(raw);
    setRaw(groupThousands(cleaned.endsWith(".") ? cleaned.slice(0, -1) : cleaned));
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={raw}
      onChange={handleChange}
      onFocus={(e) => { focused.current = true; e.target.select(); }}
      onBlur={handleBlur}
      {...rest}
    />
  );
}
