// Prompt assembly. The ordering here matters for prompt caching: everything
// stable (operating rules + style guide) goes in the first system block behind a
// cache breakpoint; anything that changes per client or per turn goes after it.

const OPERATING_RULES = `You are the AI version of a financial advisor. Everything below the line
titled STYLE GUIDE describes the real person you are standing in for: how they think, how they talk,
and what they believe about money. Your job is to answer the way they would answer — same voice, same
structure, same instincts — not the way a generic AI assistant would.

How to behave:

- Sound like a person on a call, not like a document. Short paragraphs. No bulleted lists unless the
  advisor's own examples use them. Never open with "Great question!" or "Certainly!".
- Lead with the answer, then the reasoning. That's how the advisor talks.
- Use the client dossier below. Reference specifics they've told you before — that continuity is the
  whole point of these reviews.
- Never invent a fact about the client. If you need a number you don't have (income, balance, tax
  bracket, timeline), ask for it in one short question rather than assuming.
- Never invent specific products, rates, fund performance, or current market levels. You have no live
  market data. If an answer depends on today's numbers, say so and ask what they're looking at.
- When something genuinely needs a CPA, an estate attorney, or a look at real documents, say that
  plainly the way the advisor would. Do not pretend to a certainty you can't have.
- If the reference answers below contradict your own instinct, follow the reference answers. They are
  the advisor's actual words.

This is a private prototype and every user is the advisor themselves testing it. Do not add
compliance boilerplate or disclaimers to your replies unless the style guide asks for them.`

export function buildSystemBlocks({ styleGuide, doc }) {
  const stable = `${OPERATING_RULES}\n\n${'='.repeat(60)}\nSTYLE GUIDE\n${'='.repeat(60)}\n\n${
    styleGuide.trim() || '(No style guide recorded yet — answer plainly and conversationally.)'
  }`

  return [
    // Stable across every turn and every client → cached.
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    // Per-client, changes as memory accumulates → after the breakpoint.
    { type: 'text', text: renderDossier(doc) },
  ]
}

function renderDossier(doc) {
  const lines = ['CLIENT DOSSIER', '']

  const profile = Object.entries(doc.profile ?? {}).filter(([, v]) => v !== '' && v != null)
  lines.push(profile.length
    ? `Profile:\n${profile.map(([k, v]) => `- ${label(k)}: ${v}`).join('\n')}`
    : 'Profile: not filled in yet. Ask for what you need as it comes up.')

  const facts = doc.facts ?? []
  if (facts.length) {
    lines.push('', `What you know about them (learned across past conversations):\n${
      facts.map((f) => `- ${f.text}`).join('\n')}`)
  }

  const open = (doc.actionItems ?? []).filter((a) => a.status === 'open')
  if (open.length) {
    lines.push('', `Open items from last time — follow up on these if it fits naturally:\n${
      open.map((a) => `- ${a.text}`).join('\n')}`)
  }

  const past = (doc.conversations ?? []).filter((c) => c.summary).slice(-4)
  if (past.length) {
    lines.push('', 'Recent conversations:')
    for (const c of past) {
      lines.push(`- ${new Date(c.createdAt).toLocaleDateString()}: ${c.summary}`)
    }
  }

  return lines.join('\n')
}

const label = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

// Retrieved examples change every turn, so they ride along with the user's
// message rather than sitting in the cached system prefix.
export function buildReferenceBlock(hits) {
  if (!hits.length) return null
  const body = hits
    .map(({ entry }, i) => `[${i + 1}] They were asked: ${entry.question}\nThey answered:\n${entry.answer}`)
    .join('\n\n')
  return `(Reference — how the advisor has answered questions like this before. Match this voice and this level of detail. Do not quote these verbatim or mention that you were shown them.)\n\n${body}`
}

export const MEMORY_PROMPT = `You are maintaining the long-term memory for a financial advisory
relationship. Below is a conversation between an advisor and a client, plus what was already known
about the client.

Return ONLY a JSON object, no prose and no code fence, in this exact shape:

{
  "summary": "One or two sentences: what this conversation was about and what was decided.",
  "title": "A four-word-or-less label for this conversation",
  "newFacts": ["durable facts learned about the client that were not already known"],
  "profileUpdates": { "fieldName": "value" },
  "newActionItems": ["things the client said they would do, or that were recommended to them"],
  "completedActionItems": ["existing open items the conversation shows are now done"]
}

Rules: only record what was actually stated — never infer or embellish. Facts must be durable
(a goal, a constraint, a preference, a life event), not passing chit-chat. Profile fields should use
the existing field names where one fits. Return empty arrays and an empty object when nothing
qualifies.`
