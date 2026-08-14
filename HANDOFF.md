# Icaria Bots — Handoff

For whoever is putting this on bots.icaria.pro. Read section 1 before anything else.

---

## 1. Status, honestly

| Piece | State |
| --- | --- |
| `contracts/BotVault.sol` | Compiles clean on solc 0.8.24. **Never deployed. Never audited.** |
| `contracts/SwapProbe.sol` | Compiles clean. Never deployed. |
| `keeper/` | Typechecks clean. **Never run against PulseChain.** |
| `web/App.jsx` | Complete UI. Uses simulated data, not wired to anything. |
| `web/Landing.jsx` | Complete marketing page. |

**The interface is ahead of the backend.** Several things the app offers are not
implemented in the keeper yet. See section 6. Do not ship the UI as-is and let
people switch on features that quietly do nothing.

**Nothing here has moved a real token.** Treat it as a working reference
implementation to test and harden, not as finished software. The owner is
starting with his own funds only, and that is the right call.

---

## 2. Deploy order

1. Compile `BotVault.sol` with solc 0.8.24, optimizer on, 200 runs.
   If you hit "stack too deep" after edits, enable `viaIR`.
2. Deploy `BotVault` (implementation only, never initialised directly).
3. Deploy `VaultFactory(impl, executor, treasury, router, baseToken, feeBps)`.
4. Deploy `SwapProbe(router, WPLS)`.
5. Verify all three on https://scan.pulsechain.com.
6. Fill `keeper/.env`, leave `DRY_RUN=true`.
7. `npm run doctor` until every check passes.
8. Run in dry run for at least a week. Read the logs daily.
9. Only then, live, with the owner's own money.

### Addresses

| Thing | Value |
| --- | --- |
| Chain ID | 369 |
| PulseX Router V2 | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` |
| PulseX Factory V2 | `0x29eA7545DEf87022BAdc76323F373EA1e707C523` |
| WPLS (baseToken) | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` |

Verify every one of these on the explorer before deploying against them.

### The one value that must not be wrong

`TREASURY` in `keeper/.env` and in the factory constructor is where the 0.15%
fee and the gas reimbursement land. If it is the zero address, every fee is
burned forever. `npm run doctor` checks for this. Use a normal PulseChain
address the owner controls. **A public address only. No private key or seed
phrase goes anywhere near this repo, this document, or any chat.**

---

## 3. Architecture in one paragraph

Each user deploys their own vault contract through the factory. They deposit
WPLS into it. The keeper, a Node service running around the clock, watches
PulseX prices and new pairs, decides when a user's rule is met, and calls
`executeSwap` on that user's vault. The vault swaps on PulseX, skims 0.15% plus
the gas reimbursement to the treasury, and keeps the result. **Only the vault
owner can withdraw.** The keeper can trade and nothing else.

---

## 4. Non-negotiables

Break any of these and this stops being a software product and becomes a
regulated financial business.

1. Icaria never holds user keys or funds.
2. `executeSwap` must never gain a path that sends tokens anywhere but the vault.
3. `withdraw` stays owner-only with no timelock. This is the escape hatch from
   every other bug in the system, so it is the one function that has to be right.
4. `revokeExecutor` must work whether or not the keeper is running.
5. Trade size caps and cooldowns stay enforced on-chain, not just in the UI.
6. One keeper instance only. Two sharing a key collide on nonces and silently
   drop transactions.

---

## 5. Bugs already found and fixed

Listed so nobody reintroduces them.

**Fee-on-transfer sells reverted.** The vault called
`swapExactTokensForTokens`, which reverts on any token that taxes transfers.
Buying worked, selling never would have, so any Launch Bot position in a tax
token was permanently stuck. Now always uses the
`SupportingFeeOnTransferTokens` variant and measures output by balance
difference.

**Minimum-output floor ignored tax.** `getAmountsOut` is pure reserve
arithmetic and cannot see a transfer tax, so the floor was set too high and the
swap reverted anyway. Now discounted by the tax the screener measured.

**New tokens could be bought but not sold.** The allowlist checked every token
in the path. A token created minutes ago is on nobody's allowlist, so the exit
failed. Now: spending requires an allowlisted input, but exiting to WPLS is
always permitted.

**Gas was silently paid by the operator.** The keeper signs, so the keeper paid.
At ~350 PLS a trade against a 0.15% fee, that loses money on anything under
~230,000 PLS, and loses more as users grow. Now each trade reimburses its own
gas from the vault, capped absolutely and as a share of the trade.

**Gas caps ignored spikes.** A 1% cap is 250 PLS on a 25,000 PLS trade. During
a launch, gas can hit 20,000 PLS and beyond, so the bot would have gone silent
exactly when speed mattered. Ceilings are now owner-settable, with hard caps
only to bound a compromised keeper.

**Gas share compared different units.** On a sell, `amountIn` is denominated in
the token being sold while the gas figure is in PLS. The check was meaningless.
Now applied against the WPLS side of the trade in both directions.

---

## 6. Not implemented yet

The UI offers these. The keeper does not do them. Either build them or hide the
controls before launch.

- [ ] **Sell rules.** `rules.ts` only ever buys, `[WPLS, token]`. The whole sell
      leg, including average cost tracking, is missing.
- [ ] **Average cost basis.** "Sell when I'm up 7%" needs a blended entry price
      across multiple buys. Nothing tracks it.
- [ ] **Trailing stop.** Needs a per-position high-water mark, persisted.
- [ ] **Ladder selling.** Partial exits at multiple targets.
- [ ] **Holding cap.** "Never hold more than 40% in one token" is not enforced.
      This is the most important missing safety feature, since without it a dip
      buyer will put the whole vault into one falling token.
- [ ] **Multiple bots per user.** `registry.ts` assumes one launch config and a
      flat rules array. The UI models named bots with independent state.
- [ ] **Pause and close bot.** No backend equivalent.
- [ ] **Sub-5-minute charts.** Keeper polls every 60s. Anything under 5m needs
      per-block polling on a limited watchlist.
- [ ] **Telegram alerts.**
- [ ] **Config API.** `registry.ts` expects `GET /vaults/:address/config`
      returning `{ launch, rules }`. Nothing serves it yet.
- [ ] **CSV export.**

---

## 7. Web app

`web/App.jsx` and `web/Landing.jsx` are React with Tailwind classes. They render
as-is in any Next.js app. Two things need wiring:

- Wallet connect (wagmi or viem) replacing the simulated connect screen.
- Replace the seeded arrays with reads from the vault contracts and the config
  API. Every value in the UI has a real source; nothing is decorative.

Deploy as a separate Next.js app on the subdomain, not inside the WordPress
site. Make it a PWA so it installs to a phone home screen without app store
review.

The `SEEDED` object in the keeper's `screener.ts` and the seeded arrays in
`App.jsx` are placeholders. Replace with live reads before launch.

---

## 8. Before it touches anyone's money but the owner's

- [ ] Deploy, fund with a trivial amount, and **withdraw it again**. Prove the
      exit works before trusting the entrance.
- [ ] One buy and one sell of a normal token, on chain, verified on the explorer.
- [ ] One buy and one sell of a token with a transfer tax. This is the case that
      was broken twice.
- [ ] Confirm the treasury actually received the fee and the gas reimbursement.
- [ ] Kill the keeper mid-position and restart it. Confirm no duplicate trades.
- [ ] Call `revokeExecutor` and confirm the bot stops.
- [ ] Measure real gas on a real `executeSwap` and correct `GAS_CALM` in the UI.
- [ ] A week of `DRY_RUN=true` with the logs read daily.

---

## 9. Before other people use it

A security review of `BotVault.sol`. Budget $15,000 to $40,000. It is a small
contract, so this is at the cheap end of the range, and it holds other people's
money.

Three separate bugs of the "buying works, selling doesn't" shape were found in
this code by re-reading it with a specific question in mind. That is the base
rate for unaudited contract code, and it is why the review exists.
