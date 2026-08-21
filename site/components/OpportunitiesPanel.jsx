import { useState } from "react";
import { CHAIN } from "../lib/contracts";
import DrillInScreen from "./DrillInScreen";
import InfoButton from "./InfoButton";

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

// The narrative is a full paragraph (and doubles again with the AI's own
// reasoning tacked on) - fine for one opportunity, unreadable stacked ten
// deep. This is just the first sentence, which always leads with the
// token's own symbol and the specific trigger ("PTIGER looks oversold:
// Bollinger %B -0.16 is riding the lower band."), so the collapsed view
// still says something real instead of just an address.
function firstSentence(text) {
  if (!text) return "";
  const m = text.match(/^[^.]*\./);
  return m ? m[0] : text;
}

/**
 * One opportunity Discovery Bot or Hunter Bot found - always a passed screen
 * (see keeperDb.js's getOpportunities: failed ones are filtered out before
 * this ever reaches the site, nobody wants an alert feed full of tokens they
 * can't buy). `passed` stays as a defensive check on the Buy Now button
 * rather than trusting that filter blindly here too. `action` is this
 * vault's own status for it ("notified", "bought", or none yet), read from
 * the keeper's discovery_actions table.
 *
 * Collapsed by default - a feed of full narrative-plus-AI-reasoning
 * paragraphs, one per opportunity, ate the whole screen after a few hours of
 * either bot running. Collapsed shows just enough to decide whether to look
 * closer (symbol, trigger, AI verdict); the full writeup is one tap away.
 */
function OpportunityRow({ o, onBuy, buyState, onCopyFallback }) {
  const passed = o.verdict === "pass";
  const busy = buyState === "pending";
  const bought = o.action === "bought" || buyState === "requested";
  const isHunter = o.source === "hunter";
  const [expanded, setExpanded] = useState(false);
  // Pre-filled with the AI's own sizing when there is one (already shown in
  // the narrative below), so accepting its suggestion is a single click -
  // but always editable, since the whole point is choosing your own amount
  // rather than being locked to whatever the bot would have spent.
  const [amount, setAmount] = useState(o.aiSuggestedAmountPls ? String(Math.round(o.aiSuggestedAmountPls)) : "");
  const amountValid = Number(amount) > 0;

  return (
    <div className="row-between dead-position-row">
      <div style={{ minWidth: 0 }}>
        <div
          className="row"
          style={{ gap: 8, cursor: "pointer" }}
          onClick={() => setExpanded((e) => !e)}
          role="button"
          aria-expanded={expanded}
        >
          <span className="hint" style={{ margin: 0, width: 14 }}>{expanded ? "▾" : "▸"}</span>
          <CopyAddress address={o.token} onFallback={onCopyFallback} />
          <span
            className="hint"
            style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 10 }}
          >
            {isHunter ? "Hunter" : "Discovery"}
          </span>
          <span className="hint" style={{ margin: 0 }}>{fmtTs(o.ts)}</span>
        </div>
        {!expanded && (
          <p
            className="hint"
            style={{ margin: "4px 0 0 22px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {firstSentence(o.narrative)}
            {o.aiConfidence && <span style={{ color: CONFIDENCE_COLOR[o.aiConfidence] }}> — AI would buy ({o.aiConfidence})</span>}
            {o.stale && !bought && <span style={{ color: "var(--red, #c0392b)" }}> — Expired</span>}
          </p>
        )}
        {expanded && (
          <div style={{ marginLeft: 22 }}>
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
  const [showOldScreen, setShowOldScreen] = useState(false);
  // A mechanical pass (verdict === "pass", the only kind that reaches this
  // list at all) still gets an AI opinion layered on top for Hunter Bot and
  // Discovery Bot in Full AI mode. Showing every mechanically-passed token
  // including ones the AI itself flagged as bad buys made the feed read like
  // generic token info instead of a "here's what to buy" list - so anything
  // the AI explicitly said not to buy is hidden here, not just deprioritized
  // (and never archived either - it was never a real opportunity to miss).
  // A token with no AI opinion at all (AI review off, or not yet run) still
  // shows, since "no opinion" isn't the same as "don't buy".
  const passesAiFilter = (o) => o.aiConfidence == null || o.aiRecommend;
  const isDone = (o) => o.stale || o.action === "bought";
  const live = opportunities?.filter((o) => passesAiFilter(o) && !isDone(o)) ?? [];
  // Once a signal expires or gets bought, a Buy Now button on it is either
  // wrong or pointless - it moves here instead of lingering in the live feed
  // (or, before this, disappearing with no record at all).
  const old = opportunities?.filter((o) => passesAiFilter(o) && isDone(o)) ?? [];
  const boughtCount = old.filter((o) => o.action === "bought").length;

  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <div className="section-label" style={{ margin: 0 }}>Opportunities</div>
        <InfoButton title="What's an opportunity?">
          A token one of your bots found and screened for honeypot, tax, and LP-lock risk. Showing
          up here means it passed that screen - it doesn't mean it was bought automatically, unless
          that bot's own auto-buy mode is turned on. Otherwise it just waits here for you to Buy
          Now, or moves to Old Opportunities if nobody acts on it in time.
        </InfoButton>
      </div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Tokens on {CHAIN.dexName} that Discovery Bot spotted moving (price and liquidity climbing
        together) or Hunter Bot spotted looking oversold (RSI/MACD/Bollinger), and that the AI
        didn't flag as a bad buy. Turn either bot on above to start seeing new ones. Copy a
        token's address to look it up yourself before trusting the screen alone, or set your own
        amount and buy it directly.
      </p>
      {live.length === 0 && (
        <p className="hint">Nothing live right now. This fills in as Discovery Bot or Hunter Bot runs.</p>
      )}
      {live.map((o) => (
        <OpportunityRow key={o.id} o={o} onBuy={onBuy} buyState={buyStates?.[o.id]} onCopyFallback={onCopyFallback} />
      ))}

      {old.length > 0 && (
        <button type="button" className="archive-link" onClick={() => setShowOldScreen(true)}>
          See {old.length} old opportunit{old.length === 1 ? "y" : "ies"}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      )}

      <DrillInScreen
        title="Old Opportunities"
        subtitle={`${boughtCount} bought · ${old.length - boughtCount} expired unactioned`}
        open={showOldScreen}
        onClose={() => setShowOldScreen(false)}
      >
        {old.map((o) => (
          <OpportunityRow key={o.id} o={o} onBuy={onBuy} buyState={buyStates?.[o.id]} onCopyFallback={onCopyFallback} />
        ))}
      </DrillInScreen>
    </div>
  );
}
