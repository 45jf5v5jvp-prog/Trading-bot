/**
 * Props for a controlled numeric <input>. While the field is empty (the user
 * backspaced everything out), the underlying state holds "" rather than
 * being forced back to 0 - otherwise a controlled input whose value snaps
 * straight back to "0" on every keystroke makes backspace look broken, since
 * the box never actually appears empty. Blurring an empty field commits it
 * to 0 rather than leaving "" sitting in state indefinitely.
 */
export function numberFieldProps(value, onChange) {
  return {
    type: "number",
    value,
    onFocus: (e) => e.target.select(),
    onChange: (e) => onChange(e.target.value === "" ? "" : Number(e.target.value)),
    onBlur: (e) => { if (e.target.value === "") onChange(0); },
  };
}
