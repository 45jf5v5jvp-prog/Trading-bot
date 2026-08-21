import { useState } from "react";
import Link from "next/link";
import { CHAIN } from "../lib/contracts";
import Sun from "../components/Sun";

/** One collapsed-by-default question. Click the row (or the caret) to
 * expand - only the question text shows until then, which reads much
 * cleaner than a page of permanently-open answers. */
function Q({ q, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--edge)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
          background: "none", border: "none", cursor: "pointer", padding: "14px 0",
          textAlign: "left", font: "inherit", color: "inherit",
        }}
      >
        <span className="sub-label" style={{ margin: 0 }}>{q}</span>
        <span
          aria-hidden="true"
          style={{
            color: "var(--amber)", fontSize: 12, marginLeft: 12, flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s ease",
          }}
        >
          &#9660;
        </span>
      </button>
      {open && (
        <div className="hint" style={{ fontSize: 13.5, lineHeight: 1.6, paddingBottom: 16 }}>{children}</div>
      )}
    </div>
  );
}

/**
 * Static FAQ page - no wallet connection needed, nothing here reads the
 * chain. Content is written directly from what the contracts, keeper, and
 * this site's own code actually do (BotVault.sol's invariants, each bot's
 * component-level doc comments, the referral program just built) rather
 * than paraphrased from memory, so it stays accurate as the product
 * changes. Honest about what's NOT audited and NOT guaranteed - the rest
 * of this codebase treats that kind of plain-spokenness as a feature, not
 * a hedge, and the FAQ should read the same way.
 */
export default function Faq() {
  return (
    <div className="page">
      <div className="container">
        <div className="header">
          <Sun size={26} />
          <span className="brand wordmark">ICARIA</span>
          <span className="wordmark-sub">Bots</span>
          <span className="beta-badge">BETA</span>
        </div>

        <div className="panel">
          <Link href="/" className="btn btn-small">&larr; Back to Dashboard</Link>
        </div>

        <div className="panel">
          <div className="section-label">FAQ</div>
          <p className="lede" style={{ marginBottom: 20 }}>
            How Icaria Bots actually works - the safety model, what each bot does, and what it costs.
          </p>

          <div className="sub-label" style={{ fontSize: 12, marginBottom: 12 }}>Safety and custody</div>

          <Q q="Does Icaria ever hold my funds?">
            No. Depositing creates a smart contract vault that only you own - it's deployed by a
            factory contract the first time you connect, and it's yours forever from that point on.
            Icaria's automated trading service (the "keeper") can tell your vault to swap tokens on{" "}
            {CHAIN.dexName}, and that is the ONLY thing it can do. It cannot withdraw. It cannot send
            your funds anywhere except back into your own vault or the platform's fee address for the
            small per-trade fee and gas reimbursement. Withdrawing to your own wallet is always
            available to you, the owner, with no timelock and no approval needed from anyone else.
          </Q>

          <Q q="What if Icaria's server gets hacked?">
            The worst case is real but bounded: a compromised keeper could churn your vault through
            swaps and burn value on fees and slippage. What it categorically cannot do is move a
            single token to an address you didn't choose - that boundary is enforced by the contract
            itself, not by trusting Icaria's server to behave. If you're ever worried, calling
            "Revoke Executor" from your dashboard kills the bot's ability to trade instantly, whether
            or not the keeper server is even running at the time.
          </Q>

          <Q q="Is the contract audited?">
            Not yet - be honest with yourself about that before depositing more than you'd be
            comfortable losing to an undiscovered bug. This is new software. A professional audit is
            planned before it's presented to people beyond the earliest users. Every historical bug
            found in this contract (and there have been some, in obscure edge cases like tokens that
            tax transfers) has been through independent adversarial review, not a paid audit firm -
            those are two different levels of scrutiny, and this has only had the first one so far.
          </Q>

          <Q q="Can Icaria (or anyone else) raise my fee after I've started trading?">
            No. Your vault's fee can only ever be lowered from what it was set to when your vault was
            created, never raised - that's enforced in the contract itself, not a policy that could
            change later.
          </Q>

          <Q q="What are Pause and Revoke Executor?">
            Pause stops the keeper from trading your vault immediately, while leaving deposits and
            withdrawals untouched - use it if you want to freeze trading without fully cutting the
            connection. Revoke Executor is more permanent: it removes the keeper's ability to trade
            your vault at all, period, until you explicitly grant it again. Both take effect the
            moment the transaction confirms, regardless of what the keeper server is doing.
          </Q>

          <div className="sub-label" style={{ fontSize: 12, marginBottom: 12, marginTop: 22 }}>The bots</div>

          <Q q="What is Launch Bot?">
            Buys brand-new {CHAIN.dexName} pairs on {CHAIN.chainName} the moment they open - built for
            catching a token in its first moments, before most people even know it exists. Every
            candidate is screened first: simulated buy and sell tax, whether LP is locked or burned,
            whether the deployer kept an outsized share of supply, whether ownership is renounced.
            A token that fails the screen is never bought, no matter how promising the price looks.
          </Q>

          <Q q="What is Discovery Bot?">
            Scans every token the keeper has ever seen on {CHAIN.dexName} - not just new launches -
            for price and liquidity climbing together over the last hour, which is the actual
            signature of real buying pressure rather than a wash-traded pump. It also runs a
            liquidity-coherence check to catch the opposite trap: a price crash caused by liquidity
            being pulled out, which can look exactly like a buyable dip if you only watch price.
            Every candidate still runs the same honeypot/tax/LP-lock/renounce screen as Launch Bot.
            Set it to Notify (shows candidates with a Buy Now button) or Auto-buy.
          </Q>

          <Q q="What is Hunter Bot?">
            Hunts oversold setups using real technical analysis - RSI, MACD crossovers, Bollinger
            Bands - instead of reacting to a launch or a price breakout. Trades a dedicated slice of
            your vault you choose, not the whole balance, so it can't accidentally consume funds
            you'd earmarked for something else. Optionally gated behind an AI judgment call before it
            auto-buys anything - a technical setup and a passed screen aren't enough on their own;
            Claude looks at the whole picture first, and if no AI key is configured this fails safe
            by notifying you instead of ever buying blind.
          </Q>

          <Q q="What is Ask Icaria?">
            Paste in any token address - not just ones a bot already flagged - and get a plain-English
            read on it. It runs the exact same mechanical checks every bot here runs before ever
            asking the AI anything: honeypot/sellability simulation, buy/sell tax, LP-lock percentage,
            whether ownership is renounced. The AI never overrides a failed mechanical check - if a
            token can't be sold, that's reported directly, no AI opinion substitutes for it. You can
            buy directly from the answer if you want to act on it.
          </Q>

          <Q q="What are Limit Orders and the Portfolio panel?">
            Limit Orders let you set a buy-below or sell-above price trigger on any token, independent
            of whichever bot originally bought it (or even if you funded the position some other
            way) - the keeper watches price and fires the order when your target is hit. The
            Portfolio panel shows every token your vault currently holds with its live value, so you
            always have a full picture of the vault, not just what the active bots are tracking.
          </Q>

          <div className="sub-label" style={{ fontSize: 12, marginBottom: 12, marginTop: 22 }}>Fees and referrals</div>

          <Q q="What does Icaria charge?">
            A small percentage of each trade plus a gas reimbursement for the transaction the keeper
            sends - both are capped on chain, both are visible on your own vault's dashboard, and
            both can only ever be lowered for your vault, never raised. There is no separate
            subscription or account fee; you only ever pay when your vault actually trades.
          </Q>

          <Q q="How does the referral program work?">
            Every wallet gets its own referral link, shown at the top of the dashboard once you
            connect. Anyone who creates their vault after visiting your link is credited to you,
            permanently - you earn a fixed share of the platform fee their vault generates for as
            long as they trade, and they never pay anything extra for having been referred; it comes
            out of the platform's own cut, not theirs. Earnings accrue automatically and are paid
            into your own vault in periodic batches, not on every single trade.
          </Q>

          <p className="hint" style={{ marginTop: 26 }}>
            Something not covered here? This page will keep growing as the product does - if a
            question isn't answered, that's worth telling whoever runs this deployment.
          </p>
        </div>
      </div>
    </div>
  );
}
