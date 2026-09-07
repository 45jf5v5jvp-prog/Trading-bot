import { useState } from "react";

/** Copies the full (untruncated) token address - every place on the
 * dashboard that shows a token only ever shows the shortened display form,
 * so there's nothing to select and copy by hand otherwise. Exists so a
 * token can be pasted into DexScreener or the emergency withdraw field
 * without retyping a 42-character address. Shared across every panel that
 * lists a token (Current Holdings, Closed/Rugged Positions, Portfolio) so
 * copying an address works the same way everywhere instead of some places
 * having it and others not. */
export default function CopyAddressButton({ address }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (very old browser, or not on HTTPS) -
      // nothing useful to fall back to, the address is still visible to
      // select by hand.
    }
  }
  return (
    <button type="button" className="btn btn-small" style={{ padding: "2px 8px", fontSize: 10 }} onClick={handleCopy}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}
