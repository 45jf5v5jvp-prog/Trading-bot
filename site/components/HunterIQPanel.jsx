import { useState } from "react";
import { CHAIN, EXPLORER_URL } from "../lib/contracts";

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtTsShort(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtAmount(v) {
  if (v === null || v === undefined) return "-";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals });
}

const SOURCE_LABEL = {
  owner: "You told it",
  self_loss: "It learned from a loss",
  self_miss: "It learned from a miss",
};
const SOURCE_CLASS = {
  owner: "lesson-badge-owner",
  self_loss: "lesson-badge-loss",
  self_miss: "lesson-badge-miss",
};

function LessonRow({ l }) {
  return (
    <div className="lesson-row">
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <span className={`lesson-badge ${SOURCE_CLASS[l.source] || ""}`}>{SOURCE_LABEL[l.source] || l.source}</span>
        <span className="hint" style={{ margin: 0 }}>{fmtTsShort(l.ts)}</span>
      </div>
      <p className="lesson-text">{l.text}</p>
    </div>
  );
}

function TradeRow({ t }) {
  const [expanded, setExpanded] = useState(false);
  const rationale = t.narrative || t.aiReasoning;
  return (
    <div className="trade-row">
      <div className="row-between">
        <div className="row" style={{ gap: 8 }}>
          <span className="holding-token">{short(t.token)}</span>
          <span className="hint" style={{ margin: 0 }}>{fmtTsShort(t.ts)}</span>
        </div>
        <span className="num">{fmtAmount(t.amount)} {CHAIN.nativeSymbol}</span>
      </div>
      {rationale && (
        <p className={`trade-rationale ${expanded ? "" : "trade-rationale-clamped"}`} onClick={() => setExpanded((e) => !e)}>
          {rationale}
        </p>
      )}
      {t.txHash && (
        <div className="hint" style={{ marginTop: 2 }}>
          {EXPLORER_URL
            ? <a href={`${EXPLORER_URL}/tx/${t.txHash}`} target="_blank" rel="noreferrer">{short(t.txHash)}</a>
            : short(t.txHash)}
        </div>
      )}
    </div>
  );
}

/**
 * What replaces the Opportunities panel for Hunter Bot: a justified trade
 * feed (what it bought and why, pulled from the same narrative already
 * written at buy time - see keeper/src/hunter.ts's buildNarrative) instead
 * of a queue of things waiting on a click, plus Hunter IQ - the lessons this
 * vault's bot has picked up, from the owner directly or from reflecting on
 * its own past trades (see hunter.ts's reflectOnClosedLosses/
 * reflectOnMissedOpportunities). Once a vault has any lesson at all, future
 * AI reviews for THIS vault specifically weigh that history - see ai.ts's
 * assess() guidance parameter - which is what makes one vault's Hunter
 * actually diverge from another's over time.
 */
export default function HunterIQPanel({ hunterIQ, onSubmitFeedback }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState("");
  const [showAllTrades, setShowAllTrades] = useState(false);
  const [showAllLessons, setShowAllLessons] = useState(false);

  if (!hunterIQ) return null;
  const trades = hunterIQ.trades || [];
  const lessons = hunterIQ.lessons || [];

  async function handleSubmit(e) {
    e.preventDefault();
    if (!text.trim() || status === "sending") return;
    setStatus("sending");
    setError("");
    try {
      await onSubmitFeedback(text.trim());
      setText("");
      setStatus("sent");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (err) {
      setStatus("error");
      setError(err.message || "Could not send feedback");
    }
  }

  return (
    <div className="hunter-iq">
      <div className="section-label">Hunter IQ</div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        Every trade below is justified in plain English. Tell it what to do differently and it
        weighs that on every future decision for this vault specifically - your Hunter learns on
        its own too, from its own wins, losses, and misses.
      </p>

      <div className="sub-label" style={{ marginTop: 0 }}>Hunter IQ Feedback</div>
      <form onSubmit={handleSubmit} className="feedback-box">
        <textarea
          className="feedback-input"
          placeholder="e.g. Don't buy anything with liquidity under 5,000,000 PLS, even if RSI looks great."
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          rows={3}
        />
        <div className="row-between" style={{ marginTop: 8 }}>
          <span className="hint" style={{ margin: 0 }}>{text.length}/1000</span>
          <button type="submit" className="btn btn-small btn-primary" disabled={!text.trim() || status === "sending"}>
            {status === "sending" ? "Sending..." : status === "sent" ? "Sent!" : "Send feedback"}
          </button>
        </div>
        {status === "error" && <p className="error-msg" style={{ marginTop: 8 }}>{error}</p>}
      </form>

      {lessons.length > 0 && (
        <>
          <div className="sub-label" style={{ marginTop: 18 }}>What it's learned ({lessons.length})</div>
          {(showAllLessons ? lessons : lessons.slice(0, 3)).map((l) => <LessonRow key={l.id} l={l} />)}
          {lessons.length > 3 && (
            <button type="button" className="btn btn-small" style={{ marginTop: 4, marginBottom: 14 }}
              onClick={() => setShowAllLessons((s) => !s)}>
              {showAllLessons ? "Show fewer" : `Show all ${lessons.length}`}
            </button>
          )}
        </>
      )}

      <div className="sub-label" style={{ marginTop: 18 }}>Recent trades</div>
      {trades.length === 0 && <p className="hint">No trades yet.</p>}
      {(showAllTrades ? trades : trades.slice(0, 5)).map((t) => <TradeRow key={t.id} t={t} />)}
      {trades.length > 5 && (
        <button type="button" className="btn btn-small" style={{ marginTop: 4 }}
          onClick={() => setShowAllTrades((s) => !s)}>
          {showAllTrades ? "Show fewer" : `Show all ${trades.length}`}
        </button>
      )}
    </div>
  );
}
