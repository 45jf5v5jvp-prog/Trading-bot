const { buildProfile } = require("../../../../lib/askIcaria");
const { askAboutToken } = require("../../../../lib/claude");

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
 * deployment.
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

  const answer = await askAboutToken(profile, question.trim());
  res.status(200).json({ profile, answer, error: null });
}
