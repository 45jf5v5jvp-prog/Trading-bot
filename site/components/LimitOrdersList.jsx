import LimitOrderEditor from "./LimitOrderEditor";
import { addLimitOrder, removeLimitOrderAt, updateLimitOrderAt } from "../lib/limitOrdersListOps";

/** Resting buy/sell orders on tokens the owner already holds - deposit HEX,
 * INC, PLSX, whatever, then set the price you want in or out at, instead of
 * watching a chart. Independent of the Launch Bot and Target Snipe above. */
export default function LimitOrdersList({ orders, onChange }) {
  return (
    <div>
      <div className="section-label">Limit Orders</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Hold a token in this vault (deposit it, or let a buy order fill) and set the exact price
        you want to sell at or buy more at. Fires the instant the market gets there - no
        screening beyond the trade itself succeeding, since this is a token you already chose.
      </p>
      {orders.length === 0 && <p className="hint">No orders yet. Add one to set a target price.</p>}
      {orders.map((o, i) => (
        <LimitOrderEditor
          key={o.id}
          order={o}
          onChange={(next) => onChange(updateLimitOrderAt(orders, i, next))}
          onRemove={() => onChange(removeLimitOrderAt(orders, i))}
        />
      ))}
      <button type="button" className="btn btn-small" onClick={() => onChange(addLimitOrder(orders))}>+ Add Order</button>
    </div>
  );
}
