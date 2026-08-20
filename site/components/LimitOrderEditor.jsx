import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";

/**
 * Editor for one resting limit order on a token the owner already holds or
 * has deposited - a buy target (spend base currency when price drops to X)
 * or a sell target (sell tokens when price rises to X). Pure/controlled,
 * same shape as RuleEditor/SnipeEditor.
 */
export default function LimitOrderEditor({ order, onChange, onRemove }) {
  const num = (field) => numberFieldProps(order[field] ?? 0, (v) => onChange({ ...order, [field]: v }));

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

      <div className="field-inline">
        <label>Target price ({CHAIN.nativeSymbol} per token)</label>
        <input {...num("targetPrice")} min="0" step="any" style={{ width: 160 }} />
      </div>
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
