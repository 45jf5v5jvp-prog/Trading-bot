const { id } = require("ethers");
const { authorizeHunterChat } = require("../../../../lib/auth");
const { getConfig, addHunterChatMessage, getHunterChatMessages, requestHunterFeedback } = require("../../../../lib/store");
const { getHunterTrades, getHunterLessons } = require("../../../../lib/keeperDb");
const { describeHunterContext, describeTokenProfile, replyAsHunter, TOKEN_ADDR_RE } = require("../../../../lib/hunterChat");
const { buildProfile } = require("../../../../lib/askIcaria");
const { CHAIN } = require("../../../../lib/chain");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const RPC_URL = CHAIN.rpcUrl;
const MAX_LENGTH = 1000;

function hashText(text) {
  return id(text);
}

/**
 * Talk to Your Hunter - a real conversation with this vault's own Hunter
 * Bot, grounded in its actual settings/trades/lessons (see lib/
 * hunterChat.js). GET is a public read of the thread so far (same
 * reasoning as history.js - nothing sensitive, no funds). POST requires the
 * vault owner's signature, same bar as changing bot settings, since a chat
 * message is coaching that shapes real trading decisions - see lib/
 * auth.js's authorizeHunterChat.
 *
 * Every owner message here is ALSO queued via requestHunterFeedback, the
 * exact same pipeline the plain feedback box used - hunter.ts's
 * ingestOwnerFeedback (keeper-side) doesn't know or care whether a lesson
 * came from a chat bubble or a textarea, it's the same table either way.
 * The live reply generated here is purely a site-side conversational layer
 * on top of that - it never bypasses or duplicates the keeper's own
 * ingestion.
 */
export default async function handler(req, res) {
  const { address } = req.query;
  if (typeof address !== "string" || !ADDR_RE.test(address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed vault address" });
    return;
  }
  const vault = address.toLowerCase();

  if (req.method === "GET") {
    res.status(200).json({ messages: getHunterChatMessages(vault) });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).json({ error: `method ${req.method} not allowed` });
    return;
  }

  const { message, timestampMs, signature } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > MAX_LENGTH) {
    res.status(400).json({ error: `message must be ${MAX_LENGTH} characters or fewer` });
    return;
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    res.status(400).json({ error: "signature is required" });
    return;
  }

  const trimmed = message.trim();
  try {
    await authorizeHunterChat({ vaultAddress: vault, textHash: hashText(trimmed), timestampMs, signature, rpcUrl: RPC_URL });
  } catch (e) {
    res.status(403).json({ error: e.message });
    return;
  }

  const now = Date.now();
  const history = getHunterChatMessages(vault);
  addHunterChatMessage(vault, "owner", trimmed, now);
  requestHunterFeedback(vault, trimmed, now);

  let reply = null;
  try {
    let context = describeHunterContext({
      hunterConfig: getConfig(vault).hunter,
      trades: getHunterTrades(vault),
      lessons: getHunterLessons(vault),
    });

    // Merged in from the old standalone Ask Icaria: if the owner pastes or
    // mentions a token address, run the same mechanical profile it used to
    // show and hand it to the model as extra grounding, so "is 0x... a good
    // buy" gets answered with real numbers instead of a generic reply.
    const tokenMatch = trimmed.match(TOKEN_ADDR_RE);
    if (tokenMatch) {
      const token = tokenMatch[0].toLowerCase();
      const profile = await buildProfile(token).catch((e) => ({ error: e.message }));
      context += describeTokenProfile(token, profile);
    }

    reply = await replyAsHunter(context, history, trimmed);
  } catch (e) {
    reply = null;
  }
  if (reply) addHunterChatMessage(vault, "hunter", reply, Date.now());

  res.status(200).json({ reply });
}
