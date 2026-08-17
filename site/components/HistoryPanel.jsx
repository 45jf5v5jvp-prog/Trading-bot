import { useState } from "react";

function fmtTs(unixSeconds) {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function pnlClass(pct) {
  if (pct === null || pct === undefined) return "pnl-flat";
  if (pct > 0.05) return "pnl-pos";
  if (pct < -0.05) return "pnl-neg";
  return "pnl-flat";
}

function fmtPnl(pct) {
  if (pct === null || pct === undefined) return "price unavailable";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** A rugged Launch Bot buy - down to (or effectively at) zero. Still
 * technically "open" until the keeper closes it, but showing it as a full
 * holding card next to positions that are actually alive just pushes those
 * off the screen. Treated as dead once it's clearly not coming back, not
 * only at an exact -100.0%, since a token can be down 99.9% and worth
 * fractions of a cent - still clutter, not still a decision to make. */
function isDead(p) {
  if (p.pnlPct !== null && p.pnlPct !== undefined && p.pnlPct <= -99) return true;
  if (p.valueNowPls !== null && p.valueNowPls !== undefined && p.valueNowPls < 0.000001) return true;
  return false;
}

/** Compact one-line version of a dead position - same close button, none of
 * the visual weight, so a wall of rugs doesn't cost more than one line each. */
function DeadPositionRow({ p, onClose, closeState }) {
  const requested = closeState === "requested" || closeState === "pending";
  return (
    <div className="row-between dead-position-row">
      <div className="row" style={{ gap: 10 }}>
        <span className="holding-token" style={{ fontSize: 12.5 }}>{short(p.token)}</span>
        <span className="hint" style={{ margin: 0 }}>{p.bot} · spent {p.spent_pls.toLocaleString()} PLS · worthless</span>
      </div>
      <button
        type="button"
        className="btn btn-small btn-danger"
        onClick={() => onClose(p.id)}
        disabled={requested}
      >
        {closeState === "pending" ? "..." : requested ? "Requested" : "Clear"}
      </button>
    </div>
  );
}

/** One currently-held token: what the bot bought, what it's worth right now
 * (a live PulseX quote, not a cached price), and whether that's up or down
 * since entry. This is the "should I close this?" view. */
function HoldingCard({ p, onClose, closeState }) {
  const requested = closeState === "requested" || closeState === "pending";
  return (
    <div className="holding-card">
      <div className="holding-card-top">
        <div>
          <div className="holding-token">{short(p.token)}</div>
          <div className="holding-meta">{p.bot} · opened {fmtTs(p.opened_at)}</div>
        </div>
        <div className={`num holding-pnl ${pnlClass(p.pnlPct)}`}>{fmtPnl(p.pnlPct)}</div>
      </div>
      <div className="holding-meta">
        Spent {p.spent_pls.toLocaleString()} PLS
        {p.valueNowPls !== null && p.valueNowPls !== undefined
          ? ` · worth ${Math.round(p.valueNowPls).toLocaleString()} PLS now`
          : ""}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-small btn-danger"
          onClick={() => onClose(p.id)}
          disabled={requested}
        >
          {closeState === "pending" ? "Requesting..." : requested ? "Close Requested" : "Close Position"}
        </button>
      </div>
      {requested && (
        <p className="hint" style={{ marginTop: 6 }}>
          The bot will sell this the next time it checks positions (usually within a minute)
          - closing isn't instant, since only the keeper can actually place the trade.
        </p>
      )}
    </div>
  );
}

/** Shows what the keeper has actually done for this vault - the answer to
 * "is it working?" without needing to SSH into the server and read logs.
 * Open positions are the main event: live value and P/L, refreshed on every
 * poll (see index.js), so this is the "should I close this?" screen. */
export default function HistoryPanel({ history, onClosePosition, closeStates }) {
  const [showDead, setShowDead] = useState(false);
  if (!history) return null;
  const { positions, fires } = history;
  const noHistoryYet = positions.open.length === 0 && positions.closed.length === 0 && fires.length === 0;
  const alive = positions.open.filter((p) => !isDead(p));
  const dead = positions.open.filter(isDead);

  return (
    <div>
      <div className="section-label">Current Holdings</div>
      {noHistoryYet && <p className="hint">No trades yet. This is normal for a new vault, or while DRY_RUN is on.</p>}
      {!noHistoryYet && positions.open.length === 0 && (
        <p className="hint">Nothing open right now. The bot isn't holding any tokens.</p>
      )}
      {!noHistoryYet && alive.length === 0 && dead.length > 0 && (
        <p className="hint">Nothing open worth showing right now - {dead.length} rugged {dead.length === 1 ? "position" : "positions"} below.</p>
      )}
      {alive.map((p) => (
        <HoldingCard key={p.id} p={p} onClose={onClosePosition} closeState={closeStates?.[p.id]} />
      ))}

      {dead.length > 0 && (
        <div className="dead-positions">
          <button type="button" className="btn btn-small" onClick={() => setShowDead((s) => !s)}>
            {showDead ? "Hide" : "Show"} {dead.length} rugged {dead.length === 1 ? "position" : "positions"} (-100%)
          </button>
          {showDead && (
            <div style={{ marginTop: 10 }}>
              {dead.map((p) => (
                <DeadPositionRow key={p.id} p={p} onClose={onClosePosition} closeState={closeStates?.[p.id]} />
              ))}
            </div>
          )}
        </div>
      )}

      {positions.closed.length > 0 && (
        <>
          <div className="sub-label">Closed Positions</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bot</th><th>Token</th><th>Closed</th><th>Proceeds (PLS)</th><th>Reason</th></tr></thead>
              <tbody>
                {positions.closed.map((p) => (
                  <tr key={p.id}>
                    <td>{p.bot}</td><td>{short(p.token)}</td><td>{fmtTs(p.closed_at)}</td>
                    <td>{p.proceeds_pls}</td><td>{p.close_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {fires.length > 0 && (
        <>
          <div className="sub-label">Recent Trades</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bot</th><th>Token</th><th>When</th><th>Amount (PLS)</th><th>Tx</th></tr></thead>
              <tbody>
                {fires.map((f) => (
                  <tr key={f.id}>
                    <td>{f.bot}</td><td>{short(f.token)}</td><td>{fmtTs(f.ts)}</td>
                    <td>{f.amount}</td>
                    <td>{f.tx_hash ? <a href={`https://scan.pulsechain.com/tx/${f.tx_hash}`} target="_blank" rel="noreferrer">{short(f.tx_hash)}</a> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
