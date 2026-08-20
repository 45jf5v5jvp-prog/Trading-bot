/**
 * The referral program's one real number, defined once so the API route and
 * anything that ever needs to describe it in the UI can't drift apart.
 *
 * The platform fee is 0.25% of a trade (matches DEPLOYED-ADDRESSES.md's live
 * feeBps=25). A referrer earns 0.05% of that same trade - a fixed SHARE of
 * the fee already being collected, not an extra charge on top of it, so the
 * trader never pays more for having been referred. The operator nets 0.20%
 * instead of the full 0.25% on a referred vault's trades.
 */
const REFERRAL_FEE_PCT = 0.05;
const PLATFORM_FEE_PCT = 0.25;
const REFERRAL_SHARE_OF_FEE = REFERRAL_FEE_PCT / PLATFORM_FEE_PCT; // 0.2

module.exports = { REFERRAL_FEE_PCT, PLATFORM_FEE_PCT, REFERRAL_SHARE_OF_FEE };
