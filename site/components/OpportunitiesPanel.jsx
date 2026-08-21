import { useState } from "react";
import { CHAIN } from "../lib/contracts";

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtTs(unixSeconds) {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const CONFIDENCE_COLOR = { high: "var(--green, #2e7d32)", medium: "#b8860b", low: "var(--red, #c0392b)" };

/**
 * Shortened address plus a one-tap copy of the FULL address - the short
 * form is unique enough to recognize at a glance, but pasting it into an
 * explorer to check a token out independently needs the real thing. Falls
 * back to showing the full address in the status line if the clipboard API
 * is blocked (some in-app wallet browsers do this), same fallback the
 * referral link copy button on the dashboard uses.
 */
function CopyAddress({ address, onFallback }) {
  const [copied, setCopied] = useState(false);
  if (!address) return <span className="holding-token" style={{ fontSize: 12.5 }}>-</span>;
  async function handleCopy(e) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onFallback?.(address);
    }
  }
  return (
    <span className="row" style={{ gap: 4, display: "inline-flex", alignItems: "center" }}>
      <span className="holding-token" style={{ fontSize: 12.5 }}>{short(address)}</span>
      <button type="button" className="btn btn-small" onClick={handleCopy} title={address}>
        {copied ? "Copied!" : "Copy"}
      </button>
    </span>
  );
}

/**
 * One opportunity Discovery Bot or Hunter Bot found - always a passed screen
 * (see keeperDb.js's getOpportunities: failed ones are filtered out before
 * this ever reaches the site, nobody wants an alert feed full of tokens they
 * can't buy). `passed` stays as a defensive check on the Buy Now button
 * rather than trusting that filter blindly here too. `action` is this
 * vault's own status for it ("notified", "bought", or none yet), read from
 * the keeper's discovery_actions table.
 */
function OpportunityRow({ o, onBuy, buyState, onCopyFallback }) {
  const passed = o.verdict === "pass";
  const busy = buyState === "pending";
  const bought = o.action === "bought" || buyState === "requested";
  const isHunter = o.source === "hunter";
  // Pre-filled with the AI's own sizing when there is one (already shown in
  // the narrative below), so accepting its suggestion is a single click -
  // but always editable, since the whole point is choosing your own amount
  // rather than being locked to whatever the bot would have spent.
  const [amount, setAmount] = useState(o.aiSuggestedAmountPls ? String(Math.round(o.aiSuggestedAmountPls)) : "");
  const amountValid = Number(amount) > 0;

  return (
    <div className="row-between dead-position-row">
      <div>
        <div className="row" style={{ gap: 8 }}>
          <CopyAddress address={o.token} onFallback={onCopyFallback} />
          <span
            className="hint"
            style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 10 }}
          >
            {isHunter ? "Hunter" : "Discovery"}
          </span>
          <span className="hint" style={{ margin: 0 }}>{fmtTs(o.ts)}</span>
        </div>
        <p className="hint" style={{ margin: "4px 0 0" }}>{o.narrative}</p>
        {o.aiConfidence && (
          <p className="hint" style={{ margin: "4px 0 0", color: CONFIDENCE_COLOR[o.aiConfidence] }}>
            AI: would buy ({o.aiConfidence} confidence)
            {o.aiSuggestedAmountPls
              ? ` — sizing this at ${Math.round(o.aiSuggestedAmountPls).toLocaleString()} ${CHAIN.nativeSymbol}`
              : ""}
          </p>
        )}
        {o.stale && !bought && (
          <p className="hint" style={{ margin: "4px 0 0", color: "var(--red, #c0392b)" }}>
            Expired: {o.staleReason || "too much time has passed since this was flagged."}
          </p>
        )}
      </div>
      {passed && !bought && !o.stale && (
        <span className="row" style={{ gap: 6, alignItems: "center" }}>
          <input
            type="number"
            placeholder={CHAIN.nativeSymbol}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onFocus={(e) => e.target.select()}
            disabled={busy}
            style={{ width: 90 }}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onBuy(o.id, Number(amount))}
            disabled={busy || !amountValid}
          >
            {busy ? "..." : "Buy Now"}
          </button>
        </span>
      )}
      {passed && !bought && o.stale && (
        <button type="button" className="btn btn-small" disabled title={o.staleReason || ""}>Expired</button>
      )}
      {passed && bought && (
        <button type="button" className="btn btn-small" disabled>Bought</button>
      )}
    </div>
  );
}

/**
 * Discovery Bot's and Hunter Bot's findings, one shared feed - global across
 * every vault, since each scanner runs once and screens once per token (see
 * keeper/src/discovery.ts, keeper/src/hunter.ts). Buy Now signs and submits
 * a request for whatever amount is typed into the box next to it - the
 * keeper picks the request up on its next pass, still subject to that bot's
 * own holding-cap (and, for Hunter, allocation) limits regardless of the
 * amount requested here. A notification that's gone stale (too old, or
 * price has moved enough that the original signal no longer holds - see
 * discovery.ts's refreshStaleness) shows why instead of a Buy Now button,
 * rather than either silently disappearing or staying clickable on a signal
 * that's no longer real.
 */
export default function OpportunitiesPanel({ opportunities, onBuy, buyStates, onCopyFallback }) {
  // A mechanical pass (verdict === "pass", the only kind that reaches this
  // list at all) still gets an AI opinion layered on top for Hunter Bot and
  // Discovery Bot in Full AI mode. Showing every mechanically-passed token
  // including ones the AI itself flagged as bad buys made the feed read like
  // generic token info instead of a "here's what to buy" list - so anything
  // the AI explicitly said not to buy is hidden here, not just deprioritized.
  // A token with no AI opinion at all (AI review off, or not yet run) still
  // shows, since "no opinion" isn't the same as "don't buy".
  const shown = opportunities?.filter((o) => o.aiConfidence == null || o.aiRecommend);
  return (
    <div>
      <div className="section-label">Opportunities</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Tokens on {CHAIN.dexName} that Discovery Bot spotted moving (price and liquidity climbing
        together) or Hunter Bot spotted looking oversold (RSI/MACD/Bollinger), and that the AI
        didn't flag as a bad buy. Turn either bot on above to start seeing new ones. Copy a
        token's address to look it up yourself before trusting the screen alone, or set your own
        amount and buy it directly.
      </p>
      {(!shown || shown.length === 0) && (
        <p className="hint">Nothing found yet. This fills in as Discovery Bot or Hunter Bot runs.</p>
      )}
      {shown?.map((o) => (
        <OpportunityRow key={o.id} o={o} onBuy={onBuy} buyState={buyStates?.[o.id]} onCopyFallback={onCopyFallback} />
      ))}
    </div>
  );
}
