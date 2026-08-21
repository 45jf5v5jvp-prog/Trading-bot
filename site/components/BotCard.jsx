import { useState } from "react";
import BotStatusBadge from "./BotStatusBadge";
import InfoButton from "./InfoButton";

/**
 * Collapsible shell for one bot's section - Launch/Hunter/Discovery all
 * wrap their settings form in this instead of rendering their own always-
 * visible section-label. Collapsed shows just the status and a one-line
 * performance summary (lifetime P&L, open positions - whatever the caller
 * passes as `statLine`); expanding reveals that summary in full plus a
 * nested "Settings" disclosure for the actual config fields, which stay
 * hidden until asked for. Most people checking "how's Hunter doing" never
 * need to see a single input field.
 */
export default function BotCard({ title, active, statLine, perfDetail, info, icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className={`bot-card${open ? " is-open" : ""}${active ? "" : " is-off"}`}>
      <div
        className="bot-card-head"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        aria-expanded={open}
      >
        {icon && <div className="bot-card-icon">{icon}</div>}
        <div className="bot-card-titles">
          <div className="row" style={{ gap: 8 }}>
            <span className="bot-card-title">{title}</span>
            {info && <InfoButton title={title}>{info}</InfoButton>}
            <BotStatusBadge active={active} />
          </div>
          {statLine && <div className="bot-card-stat">{statLine}</div>}
        </div>
        <svg
          className="bot-card-chevron"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
      {open && (
        <div className="bot-card-body">
          {perfDetail}
          <button
            type="button"
            className={`settings-disclosure${settingsOpen ? " is-open" : ""}`}
            onClick={() => setSettingsOpen((s) => !s)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
            {settingsOpen ? "Hide settings" : "Settings"}
          </button>
          {settingsOpen && <div className="bot-card-settings">{children}</div>}
        </div>
      )}
    </div>
  );
}
