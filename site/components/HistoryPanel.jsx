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

/** One currently-held token: what the bot bought, what it's worth right now
 * (a live PulseX quote, not a cached price), and whether that's up or down
 * since entry. This is the "should I close this?" view. */
function HoldingCard({ p }) {
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
    </div>
  );
}

/** Shows what the keeper has actually done for this vault - the answer to
 * "is it working?" without needing to SSH into the server and read logs.
 * Open positions are the main event: live value and P/L, refreshed on every
 * poll (see index.js), so this is the "should I close this?" screen. */
export default function HistoryPanel({ history }) {
  if (!history) return null;
  const { positions, fires } = history;
  const noHistoryYet = positions.open.length === 0 && positions.closed.length === 0 && fires.length === 0;

  return (
    <div>
      <div className="section-label">Current Holdings</div>
      {noHistoryYet && <p className="hint">No trades yet. This is normal for a new vault, or while DRY_RUN is on.</p>}
      {!noHistoryYet && positions.open.length === 0 && (
        <p className="hint">Nothing open right now. The bot isn't holding any tokens.</p>
      )}
      {positions.open.map((p) => <HoldingCard key={p.id} p={p} />)}

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
              <thead><tr><th>Bot</th><th>Token</th><th>When</th><th>Amount (PLS)</th><th>Fee</th><th>Tx</th></tr></thead>
              <tbody>
                {fires.map((f) => (
                  <tr key={f.id}>
                    <td>{f.bot}</td><td>{short(f.token)}</td><td>{fmtTs(f.ts)}</td>
                    <td>{f.amount}</td><td>{f.fee}</td>
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
