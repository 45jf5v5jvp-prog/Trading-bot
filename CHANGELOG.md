# Changelog

User-facing highlights only, kept for writing release announcements (e.g. the
TG group). Newest first.

Versioning: two numbers, not three - 3.1, 3.2, 3.3 for every normal round of
changes, a whole new major number only for something on the scale of v3.0's
redesign.

## v3.1 - Visual polish, bot safeguards, referral protections

- Dashboard now actually looks like the Icaria Bot Deck design: gradient hero
  cards, a status dot, an icon badge per bot instead of plain text panels.
- Trading Bots, Sniper Bot, and Limit Order Bot each got their own proper
  section like every other bot, instead of looking like plain settings panels.
- Hunter Bot now requires at least 2 of its 3 technical signals (RSI, MACD
  cross, Bollinger) to agree before something counts as an opportunity at
  all - one indicator alone isn't enough anymore. Confidence shown is now
  grounded in that real signal count, not just the AI's own word for it.
- Every PLS/token amount field now shows comma separators as you type
  (1,000,000, not 1000000) so a long number is never misread.
- Ask Icaria now checks whether your vault actually holds the token you're
  asking about and grounds "should I sell" answers in your real entry price
  and live P&L, not just generic technicals.
- Referral Protections: once someone refers a wallet, every vault that
  wallet ever creates afterward is credited to that same referrer,
  permanently - closes the loophole where a second vault could be used to
  dodge crediting the original referrer.
- Referral earnings (vaults referred, PLS earned) now shown as a real
  headline number instead of a small hint line.
- Safety and Emergency Withdraw/Revoke Executor moved to the very bottom of
  the page - the least-used, highest-caution actions, out of the way of
  everything people actually check day to day.

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
