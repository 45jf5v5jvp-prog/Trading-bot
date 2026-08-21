import { useState } from "react";

/**
 * A small "i" that opens a plain-language explanation of whatever it sits
 * next to - a bot's name, "Opportunities." Self-contained: each instance
 * owns its own open/closed state, so dropping one next to any label is a
 * one-line addition, no shared modal state to wire up.
 */
export default function InfoButton({ title, children, label }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="info-btn"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={label || `What is ${title}?`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="10.5" x2="12" y2="17" />
          <circle cx="12" cy="7" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div className="info-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="info-modal">
            <div className="info-modal-top">
              <div className="info-modal-title">{title}</div>
              <button type="button" className="info-modal-close" onClick={() => setOpen(false)} aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="info-modal-body">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
