/**
 * Props for a controlled <NumberField> (see components/NumberField.jsx),
 * which formats the value with comma separators as you type and owns the
 * "stay empty while backspacing, commit to 0 on blur" behavior this used to
 * implement directly for a plain <input type="number">. Kept as a one-line
 * helper so every call site stays `<NumberField {...numberFieldProps(...)} />`
 * regardless of where value/onChange actually live.
 */
export function numberFieldProps(value, onChange) {
  return { value, onChange };
}
