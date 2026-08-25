/**
 * Total live value of every open position, across every bot - the number
 * the vault balance alone can't show, since that's only ever the LIQUID
 * WPLS sitting idle, not what's actually deployed into open trades. Each
 * position's valueNowPls already comes from livePrice.js's quotePlsValue,
 * itself already net of sell tax AND the real platform fee/gas a close
 * would actually pay (see netOfExitCostsPls) - this sums real, already-
 * honest numbers rather than raw AMM quotes, same care as everywhere else
 * on this dashboard that shows a position's current worth. A position that
 * couldn't be priced this tick (no liquidity, a bad quote) contributes 0
 * rather than being guessed at - counted separately so the UI can say so
 * rather than silently understating the total.
 */
function openPositionsValue(history) {
  if (!history) return null;
  let valuePls = 0;
  let priced = 0;
  let unpriced = 0;
  for (const p of history.positions.open) {
    if (p.valueNowPls !== null && p.valueNowPls !== undefined) {
      valuePls += p.valueNowPls;
      priced++;
    } else {
      unpriced++;
    }
  }
  return { valuePls, count: priced + unpriced, unpriced };
}

/** An estimate, never a floor - rounds normally, unlike the vault balance's
 * own display (see index.js's fmtBalance). fmtBalance's truncate-never-
 * round-up rule exists specifically because that number is meant to be
 * typed into a withdrawal field; open-position value is never directly
 * withdrawable as typed (selling it is itself a trade, with its own
 * slippage), so pretending to that same precision would be dishonest, not
 * careful. */
function fmtEstimate(v, maxFractionDigits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}

module.exports = { openPositionsValue, fmtEstimate };
