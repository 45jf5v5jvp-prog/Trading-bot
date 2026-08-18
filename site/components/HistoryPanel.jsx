import { useState } from "react";
import { CHAIN, EXPLORER_URL } from "../lib/contracts";

function fmtTs(unixSeconds) {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Amounts in the chain's base unit (PLS / ETH). PLS amounts are huge and
 * fractional dust is noise; ETH amounts are tiny and the fraction IS the
 * money - the per-chain decimal budget comes from the chain preset. */
function fmtAmount(v) {
  if (v === null || v === undefined) return "-";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals });
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

/** Copies the full (untruncated) token address - what's shown next to it is
 * always the shortened display form, so there's nothing to select and copy
 * by hand. Exists specifically so a token can be pasted into DexScreener or
 * the emergency withdraw field without retyping a 42-character address. */
function CopyAddressButton({ address }) {
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

/** A position the DEX currently can't price at any real size - either
 * getAmountsOut reverts outright (livePrice.js leaves pnlPct/valueNowPls
 * null - typically because the LP was pulled entirely) or it still quotes
 * but for effectively nothing (rugged, not delisted). Either way there's
 * no liquidity worth trading against right now. Not a permanent verdict:
 * this runs fresh against live data on every 20s poll (see index.js), so
 * if LP gets added back and the position becomes priceable/worth something
 * again, it drops out of this bucket and reappears in Current Holdings on
 * its own - nothing here pins a position as dead forever. */
function hasNoLiquidity(p) {
  if (p.pnlPct === null || p.pnlPct === undefined) return true;
  if (p.pnlPct <= -99) return true;
  if (p.valueNowPls !== null && p.valueNowPls !== undefined && p.valueNowPls < 0.000001) return true;
  return false;
}

/** Compact one-line version of a no-liquidity position - same close button,
 * none of the visual weight, so a wall of them doesn't cost more than one
 * line each. */
function NoLiquidityPositionRow({ p, onClose, closeState }) {
  const requested = closeState === "requested" || closeState === "pending";
  const label = p.pnlPct === null || p.pnlPct === undefined ? "no liquidity to price" : "worth effectively nothing";
  return (
    <div className="row-between dead-position-row">
      <div className="row" style={{ gap: 10 }}>
        <span className="holding-token" style={{ fontSize: 12.5 }}>{short(p.token)}</span>
        <CopyAddressButton address={p.token} />
        <span className="hint" style={{ margin: 0 }}>{p.bot} · spent {fmtAmount(p.spent_pls)} {CHAIN.nativeSymbol} · {label}</span>
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
 * (a live DEX quote, not a cached price), and whether that's up or down
 * since entry. This is the "should I close this?" view. */
function HoldingCard({ p, onClose, closeState }) {
  const requested = closeState === "requested" || closeState === "pending";
  const unit = CHAIN.nativeSymbol;
  return (
    <div className="holding-card">
      <div className="holding-card-top">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <span className="holding-token">{short(p.token)}</span>
            <CopyAddressButton address={p.token} />
          </div>
          <div className="holding-meta">{p.bot} · opened {fmtTs(p.opened_at)}</div>
        </div>
        <div className={`num holding-pnl ${pnlClass(p.pnlPct)}`}>{fmtPnl(p.pnlPct)}</div>
      </div>
      <div className="holding-meta">
        Spent {fmtAmount(p.spent_pls)} {unit}
        {p.valueNowPls !== null && p.valueNowPls !== undefined
          ? ` · worth ${fmtAmount(p.valueNowPls)} ${unit} now`
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
  const [showNoLiquidity, setShowNoLiquidity] = useState(false);
  if (!history) return null;
  const { positions, fires } = history;
  const unit = CHAIN.nativeSymbol;
  const noHistoryYet = positions.open.length === 0 && positions.closed.length === 0 && fires.length === 0;
  const priced = positions.open.filter((p) => !hasNoLiquidity(p));
  const noLiquidity = positions.open.filter(hasNoLiquidity);

  return (
    <div>
      <div className="section-label">Current Holdings</div>
      {noHistoryYet && <p className="hint">No trades yet. This is normal for a brand-new vault - the bot buys on its own schedule once its settings are saved and it finds a launch that passes screening.</p>}
      {!noHistoryYet && positions.open.length === 0 && (
        <p className="hint">Nothing open right now. The bot isn't holding any tokens.</p>
      )}
      {!noHistoryYet && priced.length === 0 && noLiquidity.length > 0 && (
        <p className="hint">Nothing open worth showing right now - {noLiquidity.length} {noLiquidity.length === 1 ? "position" : "positions"} with no liquidity below.</p>
      )}
      {priced.map((p) => (
        <HoldingCard key={p.id} p={p} onClose={onClosePosition} closeState={closeStates?.[p.id]} />
      ))}

      {noLiquidity.length > 0 && (
        <div className="dead-positions">
          <button type="button" className="btn btn-small" onClick={() => setShowNoLiquidity((s) => !s)}>
            {showNoLiquidity ? "Hide" : "Show"} {noLiquidity.length} {noLiquidity.length === 1 ? "position" : "positions"} with no liquidity
          </button>
          {showNoLiquidity && (
            <div style={{ marginTop: 10 }}>
              {noLiquidity.map((p) => (
                <NoLiquidityPositionRow key={p.id} p={p} onClose={onClosePosition} closeState={closeStates?.[p.id]} />
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
              <thead><tr><th>Bot</th><th>Token</th><th>Closed</th><th>Proceeds ({unit})</th><th>Reason</th></tr></thead>
              <tbody>
                {positions.closed.map((p) => (
                  <tr key={p.id}>
                    <td>{p.bot}</td><td>{short(p.token)}</td><td>{fmtTs(p.closed_at)}</td>
                    <td>{fmtAmount(p.proceeds_pls)}</td><td>{p.close_reason}</td>
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
              <thead><tr><th>Bot</th><th>Token</th><th>When</th><th>Amount ({unit})</th><th>Tx</th></tr></thead>
              <tbody>
                {fires.map((f) => (
                  <tr key={f.id}>
                    <td>{f.bot}</td><td>{short(f.token)}</td><td>{fmtTs(f.ts)}</td>
                    <td>{fmtAmount(f.amount)}</td>
                    <td>{f.tx_hash
                      ? (EXPLORER_URL
                        ? <a href={`${EXPLORER_URL}/tx/${f.tx_hash}`} target="_blank" rel="noreferrer">{short(f.tx_hash)}</a>
                        : short(f.tx_hash))
                      : "-"}</td>
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
