const { formatUnits } = require("ethers");
const { buildProfile } = require("../../../../lib/askIcaria");
const { askAboutToken } = require("../../../../lib/claude");
const { getPositions } = require("../../../../lib/keeperDb");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * POST /api/vaults/:address/ask - "Ask Icaria" about any token address, not
 * just one a bot already flagged. Public read (the vault address in the URL
 * only scopes which vault a later "buy it" would use - this endpoint itself
 * never touches funds or writes anything, same reasoning as the portfolio
 * and opportunities routes). Body: { token, question }.
 *
 * The mechanical profile (honeypot/tax/LP-lock/owner) always runs and is
 * always returned, even if the AI is unavailable - that's the part that
 * actually protects money. The `answer` field is the AI's plain-English
 * take on top of it, or null if no ANTHROPIC_API_KEY is configured on this
 * deployment. If this vault has an open position in the exact token asked
 * about, `profile.position` carries its entry price/spend/current P&L, so
 * "should I sell" gets answered against the actual cost basis instead of
 * generic technicals - null if the vault doesn't hold it.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const { token, question } = req.body ?? {};
  if (typeof token !== "string" || !ADDR_RE.test(token)) {
    res.status(400).json({ error: "token must be a 0x-prefixed address" });
    return;
  }
  if (typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  if (question.length > 500) {
    res.status(400).json({ error: "question is too long (max 500 characters)" });
    return;
  }

  let profile;
  try {
    profile = await buildProfile(token.toLowerCase());
  } catch (e) {
    res.status(200).json({ profile: null, answer: null, error: `Could not evaluate this token: ${e.message}` });
    return;
  }
  if (profile.error) {
    res.status(200).json({ profile: null, answer: null, error: profile.error });
    return;
  }

  // If this vault already holds an open position in this exact token, a
  // "should I sell" question needs the actual cost basis to mean anything -
  // "the technicals look weak" is a very different answer at +40% than at
  // -40%. Best-effort: a missing/unreadable keeper.db just means no position
  // context, not a failure of the whole request.
  profile.position = null;
  try {
    const open = getPositions(address).open;
    const held = open.find((p) => p.token.toLowerCase() === token.toLowerCase());
    if (held) {
      const tokensHeld = Number(formatUnits(BigInt(held.tokens_held), profile.decimals ?? 18));
      profile.position = {
        bot: held.bot,
        spentPls: held.spent_pls,
        entryPrice: held.entry_price,
        tokensHeld,
        openedAt: held.opened_at,
        pnlPct: profile.priceNow != null && held.entry_price > 0
          ? ((profile.priceNow - held.entry_price) / held.entry_price) * 100
          : null,
      };
    }
  } catch { /* no position context available - describeProfile handles null fine */ }

  const answer = await askAboutToken(profile, question.trim());
  res.status(200).json({ profile, answer, error: null });
}
