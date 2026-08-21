/** One line-icon per bot, shown in the rounded chip on its BotCard header
 * (v3.0 visual pass, matching the Icaria Bot Deck design). Plain SVG paths,
 * no fill/stroke color set here - .bot-card-icon svg in globals.css colors
 * them (amber when the bot is active, dimmer when it's off). */

function Icon({ children }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function TradingBotsIcon() {
  return (
    <Icon>
      <path d="M3 17l5-6 4 4 9-10" />
      <path d="M14 5h6v6" />
    </Icon>
  );
}

export function LaunchIcon() {
  return (
    <Icon>
      <path d="M5 15l4 4M9 15l6-6c2-2 3-5 3-8 0 0-3 1-8 3l-6 6 4 4z" />
      <circle cx="14.5" cy="9.5" r="1.4" />
      <path d="M6 14c-1.5 0-3 1.5-3 4 2.5 0 4-1.5 4-3" />
    </Icon>
  );
}

export function SniperIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function DiscoveryIcon() {
  return (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </Icon>
  );
}

export function HunterIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  );
}

export function LimitOrderIcon() {
  return (
    <Icon>
      <path d="M3 12h13M11 6l6 6-6 6" />
      <path d="M16 4v4" />
    </Icon>
  );
}
