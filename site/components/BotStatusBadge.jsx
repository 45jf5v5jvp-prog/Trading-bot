/**
 * A bot's own on/off state, shown right next to its section header - same
 * visual language as the vault-wide Active/Paused badge (see .badge-active/
 * .badge-paused in globals.css), but for one specific bot rather than the
 * whole vault. Exists because a plain checkbox reading "X Bot is ON" a few
 * lines down, surrounded by a dozen other unrelated checkboxes further into
 * the panel, is easy to lose track of while scrolling - this is the first
 * thing visible the moment a bot's section comes into view.
 */
export default function BotStatusBadge({ active }) {
  return (
    <span className={active ? "badge badge-active" : "badge badge-off"} style={{ marginLeft: 10, verticalAlign: "middle" }}>
      {active ? "Active" : "Off"}
    </span>
  );
}
