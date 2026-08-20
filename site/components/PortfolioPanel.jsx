import { CHAIN } from "../lib/contracts";

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtBalance(v, decimals) {
  if (v === null || v === undefined) return "-";
  // Small-decimal tokens (HEX-style) hold huge whole-number balances where
  // more than a couple of fraction digits is noise; large-decimal tokens
  // (fresh 18-decimal launches) are usually held in small enough quantity
  // that the fraction matters. Split the difference off the token's own
  // decimals rather than a fixed budget.
  const maxFrac = decimals <= 9 ? 2 : 6;
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function fmtValue(v) {
  if (v === null || v === undefined) return "price unavailable";
  return `${Number(v).toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals })} ${CHAIN.nativeSymbol}`;
}

/** Read-only live snapshot of every token a vault's limit orders reference -
 * balance and current value, refreshed on the same poll as the rest of the
 * dashboard. This is the "what am I actually holding" view; LimitOrdersList
 * below it is where you act on it. */
export default function PortfolioPanel({ portfolio }) {
  if (!portfolio || portfolio.length === 0) {
    return (
      <div>
        <div className="section-label">Portfolio</div>
        <p className="hint">
          Nothing tracked yet. Add a limit order below for any token in this vault - HEX, INC,
          PLSX, whatever you deposited - and its live balance and value will show up here.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="section-label">Portfolio</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Live balance and value for every token your limit orders below reference.
      </p>
      {portfolio.map((p) => (
        <div key={p.token} className="holding-card">
          <div className="holding-card-top">
            <div>
              <div className="row" style={{ gap: 8 }}>
                <span className="holding-token">{p.symbol}</span>
                <span className="hint" style={{ margin: 0 }}>{short(p.token)}</span>
              </div>
            </div>
            <div className="num" style={{ fontSize: 16 }}>{fmtValue(p.valuePls)}</div>
          </div>
          <div className="holding-meta">{fmtBalance(p.balance, p.decimals)} {p.symbol}</div>
        </div>
      ))}
    </div>
  );
}
