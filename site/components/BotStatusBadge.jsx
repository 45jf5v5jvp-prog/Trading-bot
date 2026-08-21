/**
 * A bot's own on/off state, shown right next to its section header - same
 * visual language as the vault-wide Active/Paused badge (see .status-pill
 * in globals.css), but for one specific bot rather than the whole vault.
 * Exists because a plain checkbox reading "X Bot is ON" a few
 * lines down, surrounded by a dozen other unrelated checkboxes further into
 * the panel, is easy to lose track of while scrolling - this is the first
 * thing visible the moment a bot's section comes into view.
 */
export default function BotStatusBadge({ active }) {
  return (
    <span className={active ? "status-pill" : "status-pill is-off"} style={{ padding: "2px 8px 2px 6px", fontSize: 9.5 }}>
      <span className="dot" />
      {active ? "Active" : "Off"}
    </span>
  );
}
