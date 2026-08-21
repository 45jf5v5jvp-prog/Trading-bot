# Changelog

User-facing highlights only, kept for writing release announcements (e.g. the
TG group). Newest first.

## v3.0.0 - Dashboard redesign

- Full UI overhaul: P&L-first layout, far less scrolling to see what matters.
- Total P&L now shows 1h / 6h / 24h / all-time, not just a single window.
- Positions sorted largest-to-smallest, with "show more" instead of one long list.
- Closed positions moved to their own screen instead of growing the main page forever.
- Expired/actioned opportunities moved to a "see old opportunities" screen.
- Limit Orders now collapse by default and scale to many open orders at once.
- Info ("i") buttons next to Opportunities and each bot explaining what it does.
- Opportunities got a Buy Now button with a custom PLS amount you type in.
- Limit-order buy fills are now tracked as real positions - P&L, holdings, and
  a Close Position button, instead of just "bought" with no way to manage it.
- Closed positions now show the actual PLS profit/loss, not just why it closed.
- Fixed a bug where a bad gas-price reading could get a sellable position
  stuck forever instead of retrying it.
- Stuck positions now have a one-click Withdraw to Wallet button, no more
  copying the token address by hand.
