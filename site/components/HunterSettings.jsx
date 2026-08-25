import { numberFieldProps } from "../lib/numberField";
import NumberField from "./NumberField";
import { CHAIN } from "../lib/contracts";

/**
 * Editor for Hunter Bot settings. Hunts RSI/MACD/Bollinger dip-buying setups
 * across every watched token, trading a dedicated slice of the vault
 * (allocated PLS) rather than the whole balance. A liquidity-coherence check
 * (always on, not a setting here) rejects a dip whose liquidity fell more
 * than the price move alone explains - the "price cratered because LP got
 * pulled, looks like a buyable dip" trap this bot exists to avoid.
 */
export default function HunterSettings({ hunter, onChange }) {
  const num = (field) => numberFieldProps(hunter[field] ?? 0, (v) => onChange({ ...hunter, [field]: v }));

  return (
    <div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={hunter.enabled} onChange={(e) => onChange({ ...hunter, enabled: e.target.checked })} />
        {hunter.enabled ? "Hunter Bot is ON" : "Hunter Bot is OFF - settings are saved but it will not hunt for you"}
      </label>

      <div className="field-inline">
        <label>Mode</label>
        <select
          value={hunter.mode}
          onChange={(e) => onChange({ ...hunter, mode: e.target.value })}
          style={{ width: 140 }}
        >
          <option value="notify">Notify only</option>
          <option value="autoBuy">Auto-buy</option>
        </select>
      </div>

      <div className="field-inline">
        <label>Allocated {CHAIN.nativeSymbol}</label>
        {hunter.allocatedUnlimited ? (
          <span className="hint" style={{ margin: 0, fontStyle: "italic" }}>No cap</span>
        ) : (
          <NumberField {...num("allocatedPls")} min="0" style={{ width: 110 }} />
        )}
        <label>Max {CHAIN.nativeSymbol} per buy</label>
        <NumberField {...num("maxPerTradePls")} min="0" style={{ width: 100 }} />
        <label>Max buys/day</label>
        <NumberField {...num("maxPerDay")} min="0" style={{ width: 80 }} />
        <label>Max open positions</label>
        <NumberField {...num("maxOpenPositions")} min="0" style={{ width: 80 }} />
      </div>
      <div className="field-inline" style={{ marginTop: -6 }}>
        <label>Allocation resets</label>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn btn-small${!hunter.allocatedUnlimited && !hunter.allocatedResetDaily ? " btn-primary" : ""}`}
            onClick={() => onChange({ ...hunter, allocatedUnlimited: false, allocatedResetDaily: false })}
          >
            As positions close
          </button>
          <button
            type="button"
            className={`btn btn-small${hunter.allocatedResetDaily ? " btn-primary" : ""}`}
            onClick={() => onChange({ ...hunter, allocatedUnlimited: false, allocatedResetDaily: true })}
          >
            Every 24 hours
          </button>
          <button
            type="button"
            className={`btn btn-small${hunter.allocatedUnlimited ? " btn-primary" : ""}`}
            onClick={() => onChange({ ...hunter, allocatedUnlimited: true, allocatedResetDaily: false })}
          >
            No cap
          </button>
        </div>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        "Allocated" is the amount you're choosing to risk on Hunter Bot specifically, separate from
        the rest of the vault - how it frees back up depends on which button is picked above.
        "As positions close" (the default) never lets more than "Allocated" be deployed across open
        positions at once - a position sitting open a long time keeps that share of the budget tied
        up the whole time. "Every 24 hours" instead caps how much it can spend on buys in a rolling
        24-hour window, regardless of whether older positions are still open - old spend simply ages
        out and frees fresh room on its own, so a slow-closing position can't stall new buys the way
        it can under "As positions close." "No cap" removes the budget ceiling entirely - "Max per
        buy" (still enforced either way) becomes the only real limit on any one trade. "Max per buy"
        is a ceiling, not a fixed size - with AI approval on, the AI decides how much of that ceiling
        to actually spend on each buy (less when it's less confident), full authority up to the
        number you set here, never more. "Max open positions" caps how many separate bets it can be
        carrying at once regardless of leftover budget - 0 means no cap.
      </p>
      {(hunter.allocatedUnlimited || hunter.allocatedResetDaily) && Number(hunter.maxOpenPositions) === 0 && (
        <p className="hint" style={{ marginTop: -6, marginBottom: 14, color: "var(--bad)" }}>
          With no "Max open positions" cap either, this vault's Hunter Bot can open as many positions
          as it wants - which also means more of its trades competing for the same keeper queue every
          other vault's bots share. Set a real "Max open positions" number above to keep that bounded
          without capping your PLS budget.
        </p>
      )}

      <div className="sub-label">Technical setup (at least one enabled trigger must fire)</div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireRsi} onChange={(e) => onChange({ ...hunter, requireRsi: e.target.checked })} />
        RSI oversold, at or below
        <NumberField {...num("rsiOversold")} min="0" max="100" style={{ width: 70 }} disabled={!hunter.requireRsi} />
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireMacdCross} onChange={(e) => onChange({ ...hunter, requireMacdCross: e.target.checked })} />
        A bullish MACD crossover just occurred
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireBollinger} onChange={(e) => onChange({ ...hunter, requireBollinger: e.target.checked })} />
        Bollinger %B at or below
        <input
          {...numberFieldProps(hunter.bollingerPercentBMax ?? 0, (v) => onChange({ ...hunter, bollingerPercentBMax: v }))}
          min="0" max="1" step="0.01" style={{ width: 70 }} disabled={!hunter.requireBollinger}
        />
        <span className="hint" style={{ margin: 0 }}>(0 = lower band, 1 = upper band)</span>
      </label>

      <div className="field-inline">
        <label>Min liquidity ({CHAIN.nativeSymbol})</label>
        <NumberField {...num("minLiquidityPls")} min="0" style={{ width: 110 }} />
      </div>

      <div className="field-inline">
        <label>Min trades in the last 24h</label>
        <NumberField {...num("minTrades24h")} min="0" style={{ width: 70 }} />
        <span className="hint" style={{ margin: 0 }}>(0 = off)</span>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        How many separate trades this token needs recently for the bot to trust it's actually being
        traded, not just sitting still with one stale sale from days ago that happens to look
        oversold. Counted by number of trades, not dollar volume - a token like HEX or INC trades
        very differently than a small cap day to day, so a real trade count is a fairer bar than
        a fixed PLS amount.
      </p>

      <div className="field-inline">
        <label>Min different wallets trading in the last 24h</label>
        <NumberField {...num("minUniqueTraders24h")} min="0" style={{ width: 70 }} />
        <span className="hint" style={{ margin: 0 }}>(0 = off)</span>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        A trade-count floor alone can be faked by one wallet trading with itself over and over -
        this counts actual DIFFERENT wallets instead, which is much harder to fake and a better
        sign of real, broad interest rather than one whale making noise.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0 6px" }}>
        <input
          type="checkbox" checked={hunter.requireVolumeConfirmation}
          onChange={(e) => onChange({ ...hunter, requireVolumeConfirmation: e.target.checked })}
        />
        Require volume confirmation
      </label>
      <div className="field-inline" style={{ marginLeft: 21 }}>
        <label>Recent trading at least</label>
        <NumberField {...num("minVolumeRatio")} min="0" step="0.1" style={{ width: 70 }} disabled={!hunter.requireVolumeConfirmation} />
        <span className="hint" style={{ margin: 0 }}>x this token's own baseline</span>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        Unlike the triggers above, this isn't an alternative way to qualify - it's an extra
        requirement on top of them. An oversold reading on a token nobody is actually trading isn't
        much of a signal; this makes sure real volume is behind the move before trusting it.
      </p>

      <div className="sub-label">AI judgment gate</div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireAiApproval} onChange={(e) => onChange({ ...hunter, requireAiApproval: e.target.checked })} />
        Require AI approval before auto-buying
      </label>
      <div className="field-inline">
        <label>Minimum confidence</label>
        <select
          value={hunter.minAiConfidence}
          onChange={(e) => onChange({ ...hunter, minAiConfidence: e.target.value })}
          style={{ width: 120 }}
          disabled={!hunter.requireAiApproval}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        A technical setup and a passed screen are not enough to auto-buy - a Claude API call judges
        the whole picture first. With no key configured on the keeper this fails safe: it notifies
        you instead of buying, it never buys blind.
      </p>

      <div className="sub-label">Exits</div>

      <div className="field-inline">
        <label>Exit mode</label>
        <select
          value={hunter.exitMode}
          onChange={(e) => onChange({ ...hunter, exitMode: e.target.value })}
          style={{ width: 160 }}
        >
          <option value="limited">Auto Limited</option>
          <option value="full">Auto Full</option>
        </select>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        {hunter.exitMode === "full"
          ? "Auto Full gives the AI ongoing authority to decide when to exit - it re-checks each open position and can ride a winner past what a fixed target would have locked in. The stop loss below still applies no matter what it decides; take profit, trailing stop, and time exit are not used in this mode."
          : "Auto Limited exits at the fixed targets below, same as every other bot here. Switch to Auto Full to hand the AI ongoing authority over when to exit instead."}
      </p>

      <div className="field-inline">
        {hunter.exitMode === "limited" && (
          <>
            <label>Take profit %</label>
            <NumberField {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
          </>
        )}
        <label>Stop loss %{hunter.exitMode === "full" ? " (mandatory floor)" : ""}</label>
        <NumberField {...num("stopLossPct")} min="0" style={{ width: 80 }} disabled={hunter.useAtrStop} />
        {hunter.exitMode === "limited" && (
          <>
            <label>Time exit (min)</label>
            <NumberField {...num("timeExitMin")} min="0" style={{ width: 80 }} />
          </>
        )}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0 6px" }}>
        <input type="checkbox" checked={hunter.useAtrStop} onChange={(e) => onChange({ ...hunter, useAtrStop: e.target.checked })} />
        Size the stop off this token's own volatility (ATR) instead of a flat %
      </label>
      <div className="field-inline" style={{ marginLeft: 21 }}>
        <label>Multiplier</label>
        <NumberField {...num("atrStopMultiplier")} min="0" step="0.5" style={{ width: 60 }} disabled={!hunter.useAtrStop} />
        <span className="hint" style={{ margin: 0 }}>x ATR</span>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        A volatile token gets a wider stop, a calm one a tighter one, instead of every token using
        the same fixed percentage regardless of how much it normally moves. Falls back to the flat
        stop loss % above if ATR wasn't available yet when the trade opened.
      </p>

      {hunter.exitMode === "limited" && (
        <div className="field-inline">
          <label>Trailing stop %</label>
          <NumberField {...num("trailingStopPct")} min="0" style={{ width: 80 }} />
        </div>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0 6px" }}>
        <input
          type="checkbox" checked={hunter.autoRebuyOnExit}
          onChange={(e) => onChange({ ...hunter, autoRebuyOnExit: e.target.checked })}
        />
        Auto-rebuy on a good exit
      </label>
      <div className="field-inline" style={{ marginLeft: 21 }}>
        <label>Rebuy if it drops</label>
        <NumberField {...num("autoRebuyDipPct")} min="0" max="99" style={{ width: 70 }} disabled={!hunter.autoRebuyOnExit} />
        <span className="hint" style={{ margin: 0 }}>% below the exit price, expiring after</span>
        <NumberField {...num("autoRebuyExpireHours")} min="0" style={{ width: 70 }} disabled={!hunter.autoRebuyOnExit} />
        <span className="hint" style={{ margin: 0 }}>hours</span>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        When the bot takes profit or exits on its own AI judgment - never on a stop-loss, and never
        after you manually close a position - it queues a resting rebuy some percent below where it
        sold, so a real pullback becomes a better entry instead of walking away for good. Sized the
        same as the position that just closed, still subject to your allocation and holding cap.
      </p>

      <div className="sub-label">Screening limits (a token failing any of these is never buyable, notify or auto-buy)</div>

      <div className="field-inline">
        <label>Max buy tax (bps)</label>
        <NumberField {...num("maxBuyTaxBps")} min="0" style={{ width: 90 }} />
        <label>Max sell tax (bps)</label>
        <NumberField {...num("maxSellTaxBps")} min="0" style={{ width: 90 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireLpLock} onChange={(e) => onChange({ ...hunter, requireLpLock: e.target.checked })} />
        Require LP locked/burned
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireOwnerRenounced} onChange={(e) => onChange({ ...hunter, requireOwnerRenounced: e.target.checked })} />
        Require ownership renounced
      </label>
    </div>
  );
}
