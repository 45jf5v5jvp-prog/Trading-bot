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

/** Date for a dense list row. The full toLocaleString wraps to three lines
 * inside a narrow cell on a phone; month/day plus time is enough to place
 * a trade, and seconds never matter here. */
function fmtTsShort(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** close_reason is written for the keeper log and can be a whole sentence,
 * which used to blow a table row up to phone-screen height. The list shows a
 * short label; the full sentence stays on the row's title attribute. */
function shortReason(reason, status) {
  if (!reason) return status === "stuck" ? "stuck" : "";
  const r = reason.toLowerCase();
  if (r.startsWith("trailing stop")) return reason.split(" (")[0];
  if (r.startsWith("take profit") || r.startsWith("stop loss") || r.startsWith("time exit")) return reason;
  if (r.startsWith("closed by owner")) return "closed by owner";
  if (r.startsWith("balance vanished")) return "rugged";
  if (r.startsWith("cannot sell")) return "unsellable";
  if (r.startsWith("retired")) return "retired";
  return reason.length > 30 ? `${reason.slice(0, 28)}...` : reason;
}

/** Realized outcome of a closed position. Null when it never sold (stuck
 * positions have no proceeds), which renders as a dash rather than a fake 0. */
function realizedPnlPct(p) {
  if (p.proceeds_pls === null || p.proceeds_pls === undefined || !p.spent_pls) return null;
  return (p.proceeds_pls / p.spent_pls - 1) * 100;
}

function ClosedPositionRow({ p }) {
  const pnl = realizedPnlPct(p);
  return (
    <div className="closed-row" title={p.close_reason || ""}>
      <span className="closed-bot">{p.bot}</span>
      <span className="closed-token">{short(p.token)}</span>
      <span className="closed-date">{fmtTsShort(p.closed_at)}</span>
      <span className={`closed-pnl ${pnlClass(pnl)}`}>{pnl === null ? "-" : fmtPnl(pnl)}</span>
      <span className="closed-reason">{shortReason(p.close_reason, p.status)}</span>
    </div>
  );
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

const BOT_LABELS = {
  all: "All", launch: "Launch", discovery: "Discovery", hunter: "Hunter",
  trading: "Rules", snipe: "Snipe", limit: "Limit Order", ask: "Ask Icaria",
};

/** Every bot identifier actually present in this vault's history, in a
 * fixed display order - so the filter row only ever shows bots that have
 * actually done something here, never a wall of empty tabs for bots this
 * vault has never used. */
function botsPresent(history) {
  const seen = new Set();
  for (const p of history.positions.open) seen.add(p.bot);
  for (const p of history.positions.closed) seen.add(p.bot);
  for (const f of history.fires) seen.add(f.bot);
  return Object.keys(BOT_LABELS).filter((k) => k !== "all" && seen.has(k));
}

/** Shows what the keeper has actually done for this vault - the answer to
 * "is it working?" without needing to SSH into the server and read logs.
 * Open positions are the main event: live value and P/L, refreshed on every
 * poll (see index.js), so this is the "should I close this?" screen. The bot
 * filter lets someone check one bot at a time - e.g. "just show me what
 * Discovery Bot is doing" - without hiding anything, since "All" stays the
 * default view.
 */
export default function HistoryPanel({ history, onClosePosition, closeStates }) {
  const [showNoLiquidity, setShowNoLiquidity] = useState(false);
  const [showAllClosed, setShowAllClosed] = useState(false);
  const [showAllTrades, setShowAllTrades] = useState(false);
  const [botFilter, setBotFilter] = useState("all");
  if (!history) return null;
  const unit = CHAIN.nativeSymbol;
  const noHistoryYet = history.positions.open.length === 0 && history.positions.closed.length === 0 && history.fires.length === 0;
  const available = botsPresent(history);
  const matches = (bot) => botFilter === "all" || bot === botFilter;
  const positions = {
    open: history.positions.open.filter((p) => matches(p.bot)),
    closed: history.positions.closed.filter((p) => matches(p.bot)),
  };
  const fires = history.fires.filter((f) => matches(f.bot));
  const priced = positions.open.filter((p) => !hasNoLiquidity(p));
  const noLiquidity = positions.open.filter(hasNoLiquidity);

  return (
    <div>
      <div className="row-between" style={{ marginBottom: available.length > 1 ? 10 : 0 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>Current Holdings</div>
        {available.length > 1 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {["all", ...available].map((key) => (
              <button
                key={key}
                type="button"
                className={botFilter === key ? "btn btn-small btn-primary" : "btn btn-small"}
                onClick={() => setBotFilter(key)}
              >
                {BOT_LABELS[key]}
              </button>
            ))}
          </div>
        )}
      </div>
      {noHistoryYet && <p className="hint">No trades yet. This is normal for a brand-new vault - the bot buys on its own schedule once its settings are saved and it finds a launch that passes screening.</p>}
      {!noHistoryYet && botFilter !== "all" && positions.open.length === 0 && positions.closed.length === 0 && fires.length === 0 && (
        <p className="hint">Nothing from {BOT_LABELS[botFilter]} yet.</p>
      )}
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
          <div className="closed-list">
            {(showAllClosed ? positions.closed : positions.closed.slice(0, 8)).map((p) => (
              <ClosedPositionRow key={p.id} p={p} />
            ))}
          </div>
          {positions.closed.length > 8 && (
            <button type="button" className="btn btn-small" style={{ marginTop: 8 }}
              onClick={() => setShowAllClosed((s) => !s)}>
              {showAllClosed ? "Show fewer" : `Show all ${positions.closed.length}`}
            </button>
          )}
        </>
      )}

      {fires.length > 0 && (
        <>
          <div className="sub-label">Recent Trades</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bot</th><th>Token</th><th>When</th><th>Amount ({unit})</th><th>Tx</th></tr></thead>
              <tbody>
                {(showAllTrades ? fires : fires.slice(0, 8)).map((f) => (
                  <tr key={f.id}>
                    <td>{f.bot}</td><td>{short(f.token)}</td><td>{fmtTsShort(f.ts)}</td>
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
          {fires.length > 8 && (
            <button type="button" className="btn btn-small" style={{ marginTop: 8 }}
              onClick={() => setShowAllTrades((s) => !s)}>
              {showAllTrades ? "Show fewer" : `Show all ${fires.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
