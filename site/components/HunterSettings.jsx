import { numberFieldProps } from "../lib/numberField";
import NumberField from "./NumberField";
import { CHAIN } from "../lib/contracts";

/**
 * Editor for Hunter Bot settings. Hunts real order-flow/liquidity-flow
 * setups - buy pressure, liquidity growth, new-buyer growth, a breakout
 * above the token's own recent high - across every watched token, trading a
 * dedicated slice of the vault (allocated PLS) rather than the whole
 * balance. A liquidity-coherence check (always on, not a setting here)
 * rejects a move whose liquidity fell more than the price move alone
 * explains - the "price cratered because LP got pulled, looks like real
 * momentum" trap this bot exists to avoid.
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
        is a ceiling, not a fixed size - it spends up to that amount on each qualifying buy, never
        more. "Max open positions" caps how many separate bets it can be carrying at once regardless
        of leftover budget - 0 means no cap.
      </p>
      {(hunter.allocatedUnlimited || hunter.allocatedResetDaily) && Number(hunter.maxOpenPositions) === 0 && (
        <p className="hint" style={{ marginTop: -6, marginBottom: 14, color: "var(--bad)" }}>
          With no "Max open positions" cap either, this vault's Hunter Bot can open as many positions
          as it wants - which also means more of its trades competing for the same keeper queue every
          other vault's bots share. Set a real "Max open positions" number above to keep that bounded
          without capping your PLS budget.
        </p>
      )}

      <div className="sub-label">Order-flow setup (every enabled requirement must pass)</div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
        Not RSI/MACD/Bollinger - those are all read off price alone, so requiring several to agree
        wasn't real diversification. These four read real on-chain data instead: which way trades
        are actually going, whether capital is actually committing, whether new wallets are actually
        showing up, and whether price is actually confirming strength rather than guessing a bottom.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireBuyPressure} onChange={(e) => onChange({ ...hunter, requireBuyPressure: e.target.checked })} />
        At least
        <input
          {...numberFieldProps(hunter.minBuyPressureRatio ?? 0, (v) => onChange({ ...hunter, minBuyPressureRatio: v }))}
          min="0" max="1" step="0.05" style={{ width: 70 }} disabled={!hunter.requireBuyPressure}
        />
        of recent trades were buys, not sells
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireLiquidityGrowth} onChange={(e) => onChange({ ...hunter, requireLiquidityGrowth: e.target.checked })} />
        Liquidity grew at least
        <NumberField {...num("minLiquidityGrowthPct")} step="1" style={{ width: 70 }} disabled={!hunter.requireLiquidityGrowth} />
        <span className="hint" style={{ margin: 0 }}>% over the last hour (0 = just not shrinking)</span>
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireBuyerGrowth} onChange={(e) => onChange({ ...hunter, requireBuyerGrowth: e.target.checked })} />
        At least
        <NumberField {...num("minNewBuyers")} min="0" style={{ width: 60 }} disabled={!hunter.requireBuyerGrowth} />
        distinct new buyers in the last hour
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireBreakout} onChange={(e) => onChange({ ...hunter, requireBreakout: e.target.checked })} />
        Price just broke out to a new local high
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
        traded, not just sitting still with one stale sale from days ago. Counted by number of
        trades, not dollar volume - a token like HEX or INC trades very differently than a small cap
        day to day, so a real trade count is a fairer bar than a fixed PLS amount.
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
        An extra requirement on top of the ones above, not an alternative way to qualify. A reading
        on a token nobody is actually trading isn't much of a signal; this makes sure real volume is
        behind the move before trusting it.
      </p>

      <div className="sub-label">Exits</div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        Hunter is a mechanical day-trading bot - no AI judgment anywhere, buy or sell. Set a real
        "Time exit" so a position that never hits its stop or trail still gets closed within hours
        instead of sitting open indefinitely.
      </p>

      <div className="field-inline">
        <label>Take profit % (0 = let the trail decide)</label>
        <NumberField {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
        <label>Stop loss %</label>
        <NumberField {...num("stopLossPct")} min="0" style={{ width: 80 }} disabled={hunter.useAtrStop} />
        <label>Time exit (min)</label>
        <NumberField {...num("timeExitMin")} min="0" style={{ width: 80 }} />
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

      <div className="field-inline">
        <label>Tight trail %</label>
        <NumberField {...num("tightTrailPct")} min="0" style={{ width: 70 }} />
        <label>until peak gain reaches</label>
        <NumberField {...num("trailWidenAtPct")} min="0" style={{ width: 70 }} />
        <span className="hint" style={{ margin: 0 }}>%, then</span>
        <label>wide trail %</label>
        <NumberField {...num("trailingStopPct")} min="0" style={{ width: 70 }} />
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        A tiered trailing stop, not one fixed distance - this is what delivers "a quick 4% win is
        fine, exit it, but let a real move run toward 10-15%+." Below the peak-gain threshold, the
        tight trail applies: a small pullback from an early peak sells close to that peak, capturing
        most of a fast pump that stalls out. Once the position's peak gain passes that threshold, the
        wider trail takes over instead, giving a real move room to keep running rather than getting
        stopped out on every wiggle. Set either trail % to 0 to disable that tier.
      </p>

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
        When the bot takes profit or hits its trailing stop - never on a stop-loss, and never
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
