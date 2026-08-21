import { useState } from "react";
import LimitOrderEditor from "./LimitOrderEditor";
import { addLimitOrder, removeLimitOrderAt, updateLimitOrderAt } from "../lib/limitOrdersListOps";
import { CHAIN } from "../lib/contracts";
import InfoButton from "./InfoButton";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** An order with no real token address yet is mid-setup, not something to
 * hide - only a configured order collapses to a summary line by default. */
function isConfigured(o) {
  return ADDR_RE.test(o.token || "");
}

function summaryLine(o) {
  const dir = o.side === "sell" ? `Sell ≥` : `Buy ≤`;
  const price = Number(o.targetPrice) > 0 ? Number(o.targetPrice).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "-";
  return `${dir} ${price} ${CHAIN.nativeSymbol}/token · ${o.enabled ? "Armed" : "Off"}`;
}

/**
 * Each order collapses to one line - token, side, target price, armed/off -
 * however many are outstanding, so 6 orders reads the same as 2 instead of
 * stacking 6 full edit forms down the page. Tapping one reveals the same
 * LimitOrderEditor form this always used, unchanged; collapsing is purely a
 * display concern layered on top; it doesn't clear or discard anything.
 */
export default function LimitOrdersList({ orders, onChange }) {
  const [openIds, setOpenIds] = useState(() => new Set(orders.filter((o) => !isConfigured(o)).map((o) => o.id)));

  function toggle(id) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleAdd() {
    const next = addLimitOrder(orders);
    const added = next[next.length - 1];
    setOpenIds((prev) => new Set(prev).add(added.id));
    onChange(next);
  }

  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <div className="section-label" style={{ margin: 0 }}>Limit Orders</div>
        <InfoButton title="What are Limit Orders?">
          A resting buy or sell order on a token you already hold or already trust - you set the
          price, it fires the instant the market reaches it. No honeypot or tax screening runs on
          these, since the assumption is you already know the token. You can have as many
          outstanding at once as you want; each one stays collapsed until you tap it.
        </InfoButton>
      </div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Hold a token in this vault (deposit it, or let a buy order fill) and set the exact price
        you want to sell at or buy more at. Each order fires the instant the market gets there -
        no screening beyond the trade itself succeeding, since this is a token you already chose.
        However many you have outstanding, they stay collapsed until you tap one.
      </p>
      {orders.length === 0 && <p className="hint">No orders yet. Add one to set a target price.</p>}
      {orders.map((o, i) => {
        const open = openIds.has(o.id);
        return (
          <div key={o.id} style={{ marginBottom: 8 }}>
            <button
              type="button"
              className="order-toggle"
              aria-expanded={open}
              onClick={() => toggle(o.id)}
            >
              <div className="order-toggle-left">
                <div className="holding-badge">{isConfigured(o) ? short(o.token).slice(2, 5).toUpperCase() : "?"}</div>
                <div>
                  <div className="order-toggle-name">{isConfigured(o) ? short(o.token) : "New order"}</div>
                  <div className="order-toggle-meta">{summaryLine(o)}</div>
                </div>
              </div>
              <svg
                className="order-chevron"
                style={open ? { transform: "rotate(180deg)", color: "var(--amber)" } : undefined}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {open && (
              <LimitOrderEditor
                order={o}
                onChange={(next) => onChange(updateLimitOrderAt(orders, i, next))}
                onRemove={() => onChange(removeLimitOrderAt(orders, i))}
              />
            )}
          </div>
        );
      })}
      <button type="button" className="btn btn-small" onClick={handleAdd}>+ Add Order</button>
    </div>
  );
}
