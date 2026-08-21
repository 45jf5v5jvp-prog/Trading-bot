import { useState } from "react";
import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";
import { quoteTokenPrice } from "../lib/quoteTokenPrice";

/**
 * Editor for one resting limit order on a token the owner already holds or
 * has deposited - a buy target (spend base currency when price drops to X)
 * or a sell target (sell tokens when price rises to X). Pure/controlled,
 * same shape as RuleEditor/SnipeEditor.
 *
 * The saved order only ever carries an absolute targetPrice - that's the
 * one number the keeper checks. "% from current" here is purely a data
 * entry convenience: it fetches today's price once, lets you type a
 * percent, and writes the resolved absolute price into targetPrice. It
 * deliberately does NOT persist as "25% above whatever the price is later" -
 * a resting order tracking a moving "current" would never fire, since
 * "current" would always just equal itself.
 */
export default function LimitOrderEditor({ order, onChange, onRemove }) {
  const num = (field) => numberFieldProps(order[field] ?? 0, (v) => onChange({ ...order, [field]: v }));

  const [mode, setMode] = useState("price"); // "price" | "percent" - editor-local, not saved
  const [percent, setPercent] = useState(order.side === "sell" ? 25 : -15);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [priceStatus, setPriceStatus] = useState(""); // "", "loading", "error"

  async function fetchCurrentPrice(applyPercent) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(order.token)) {
      setPriceStatus("error");
      return;
    }
    setPriceStatus("loading");
    try {
      const price = await quoteTokenPrice(order.token);
      setCurrentPrice(price);
      setPriceStatus("");
      if (applyPercent) onChange({ ...order, targetPrice: price * (1 + percent / 100) });
    } catch {
      setCurrentPrice(null);
      setPriceStatus("error");
    }
  }

  /** Same "let the field hold '' while editing" fix as lib/numberField.js -
   * this one can't use that helper directly since clearing/retyping also
   * needs to recompute targetPrice live, not just commit a plain number. */
  function handlePercentChange(raw) {
    setPercent(raw);
    if (raw === "") return;
    const v = Number(raw);
    if (currentPrice !== null && Number.isFinite(v)) onChange({ ...order, targetPrice: currentPrice * (1 + v / 100) });
  }

  return (
    <div className="rule-panel">
      <div className="rule-panel-header">
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={order.enabled} onChange={(e) => onChange({ ...order, enabled: e.target.checked })} />
          {order.enabled ? "Armed — fires the moment the price is right" : "Off — saved but not watching"}
        </label>
        <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>Remove</button>
      </div>

      <div className="field">
        <label>Token contract address</label>
        <input
          value={order.token}
          onChange={(e) => onChange({ ...order, token: e.target.value })}
          placeholder="0x..."
          style={{ width: "100%" }}
        />
      </div>

      <div className="field-inline">
        <label>Side</label>
        <select value={order.side} onChange={(e) => onChange({ ...order, side: e.target.value })}>
          <option value="sell">Sell — take profit at a target price</option>
          <option value="buy">Buy — add more if it drops to a target price</option>
        </select>
      </div>

      <div className="field-inline" style={{ marginBottom: 8 }}>
        <label>Set target by</label>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={mode === "price" ? "btn btn-small btn-primary" : "btn btn-small"}
            onClick={() => setMode("price")}
          >
            Price
          </button>
          <button
            type="button"
            className={mode === "percent" ? "btn btn-small btn-primary" : "btn btn-small"}
            onClick={() => { setMode("percent"); fetchCurrentPrice(true); }}
          >
            % from current
          </button>
        </div>
      </div>

      {mode === "price" ? (
        <div className="field-inline">
          <label>Target price ({CHAIN.nativeSymbol} per token)</label>
          <input {...num("targetPrice")} min="0" step="any" style={{ width: 160 }} />
        </div>
      ) : (
        <>
          <div className="field-inline">
            <label>{order.side === "sell" ? "% above current" : "% below current"}</label>
            <input
              type="number" step="any"
              value={percent}
              onFocus={(e) => e.target.select()}
              onChange={(e) => handlePercentChange(e.target.value)}
              onBlur={(e) => { if (e.target.value === "") handlePercentChange("0"); }}
              style={{ width: 100 }}
            />
            <button type="button" className="btn btn-small" onClick={() => fetchCurrentPrice(true)}>
              {priceStatus === "loading" ? "Fetching..." : "Refresh price"}
            </button>
          </div>
          {priceStatus === "error" && (
            <p className="hint" style={{ color: "var(--bad)", marginTop: -4 }}>
              Couldn't get a live price for that address. Enter the token address above, or switch to "Price" and type a target directly.
            </p>
          )}
          {currentPrice !== null && priceStatus !== "error" && (
            <p className="hint" style={{ marginTop: -4 }}>
              Current: {currentPrice.toPrecision(6)} {CHAIN.nativeSymbol} → target: {order.targetPrice ? order.targetPrice.toPrecision(6) : "-"} {CHAIN.nativeSymbol}
            </p>
          )}
        </>
      )}
      <p className="hint" style={{ marginTop: -4 }}>
        {order.side === "sell"
          ? `Sells the moment the price is at or above this.`
          : `Buys the moment the price is at or below this.`}
      </p>

      {order.side === "sell" ? (
        <>
          <div className="field-inline">
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={order.sellAll} onChange={(e) => onChange({ ...order, sellAll: e.target.checked })} />
              Sell the entire balance
            </label>
          </div>
          {!order.sellAll && (
            <div className="field-inline">
              <label>Tokens to sell</label>
              <input {...num("amount")} min="0" step="any" style={{ width: 160 }} />
            </div>
          )}
        </>
      ) : (
        <div className="field-inline">
          <label>{CHAIN.nativeSymbol} to spend</label>
          <input {...num("amount")} min="0" style={{ width: 160 }} />
        </div>
      )}
    </div>
  );
}
