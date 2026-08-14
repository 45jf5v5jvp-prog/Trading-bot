function fmtTs(unixSeconds) {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Shows what the keeper has actually done for this vault - the answer to
 * "is it working?" without needing to SSH into the server and read logs. */
export default function HistoryPanel({ history }) {
  if (!history) return null;
  const { positions, fires } = history;
  const noHistoryYet = positions.open.length === 0 && positions.closed.length === 0 && fires.length === 0;

  return (
    <div>
      <h2>Bot Activity</h2>
      {noHistoryYet && <p>No trades yet. This is normal for a new vault, or while DRY_RUN is on.</p>}

      {positions.open.length > 0 && (
        <>
          <h3>Open Positions</h3>
          <table>
            <thead><tr><th>Bot</th><th>Token</th><th>Opened</th><th>Spent (PLS)</th><th>Entry price</th></tr></thead>
            <tbody>
              {positions.open.map((p) => (
                <tr key={p.id}>
                  <td>{p.bot}</td><td>{short(p.token)}</td><td>{fmtTs(p.opened_at)}</td>
                  <td>{p.spent_pls}</td><td>{p.entry_price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {positions.closed.length > 0 && (
        <>
          <h3>Closed Positions</h3>
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
        </>
      )}

      {fires.length > 0 && (
        <>
          <h3>Recent Trades</h3>
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
        </>
      )}
    </div>
  );
}
