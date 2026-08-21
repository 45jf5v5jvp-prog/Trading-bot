/**
 * A full-screen slide-in view for a list that would otherwise grow forever
 * on the main page - closed positions, old opportunities. Both genuinely
 * accumulate without bound over the life of a vault, so they live off the
 * main scroll path entirely instead of an inline "show more" that just
 * delays the same problem.
 */
export default function DrillInScreen({ title, subtitle, open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="drill-in-overlay">
      <div className="drill-in-head">
        <button type="button" className="drill-in-back" onClick={onClose} aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div>
          <div className="drill-in-title">{title}</div>
          {subtitle && <div className="drill-in-sub">{subtitle}</div>}
        </div>
      </div>
      <div className="drill-in-body">{children}</div>
    </div>
  );
}
