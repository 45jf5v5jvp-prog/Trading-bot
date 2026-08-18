# AI advisor — private prototype

A feasibility build: log in, have a financial review with an AI that answers the way
*you* answer, and have it remember the conversation for next time. Single user, runs on
your machine, nothing deployed and nobody else can reach it.

The question this is meant to settle is "does this actually feel like me, and does the
memory make it feel like a relationship?" Everything else — billing, multi-tenant auth,
video avatar — is deliberately left out.

## Run it

```bash
cd advisor
npm install
cp .env.example .env      # add your Anthropic API key and pick a passcode
npm run dev               # http://localhost:5273
```

`npm run dev` starts the API on :8787 and the web app on :5273. For a single production
process: `npm run build && npm start`, then open http://localhost:8787.

## The part that matters: making it sound like you

Three files, all under `persona/`:

- **`style-guide.md`** — your judgment, in first person. Currently a template with prompts
  in it. Replace it entirely. This gets loaded into every conversation.
- **`positions.md`** — where you don't move, and what you say the second and third time
  someone leans on you. See "Not folding" below; this file is why it exists.
- **`qa/*.md`** — your actual answers to actual questions. Four samples ship as a format
  demo; delete them and put your own in. See `persona/README.md` for the format and for
  the fastest way to build the corpus (talk, transcribe, paste).

Both reload when the files change — edit and send another message, no restart.

At answer time the app pulls the five recorded answers closest to what was asked (BM25
over your corpus) and shows them to the model alongside your style guide. The chat panel
has a "show the recorded answers this drew on" toggle so you can see exactly which of
your answers shaped a reply — that's the fastest way to find the gaps in your corpus.

## Not folding

The known failure mode of AI advice is that it agrees with you. It won't do it on the first
answer — it does it on the third, after a client has pushed back twice, and it sounds like
*"That's a fair point, ultimately it's your call."* An advisor whose value is partly in
saying no cannot ship that.

Three things push against it, and none of them work alone:

1. **`persona/positions.md`** — the things you don't move on, each with what you say when
   someone leans on it, and what new fact *would* legitimately change your mind. It sits in
   the cached system prompt with the style guide, so it's in front of the model on every turn.
2. **A push-back detector** (`server/pressure.js`) — when a client's message is pressure
   rather than new information (asking again, asking harder, "everyone else is doing it",
   "I'm doing it anyway"), the server appends a mid-conversation system message before the
   reply is written: hold the line, say it shorter, don't hedge into options, don't open by
   conceding. A message carrying an actual new fact deliberately does *not* trigger it —
   changing your mind on new information is correct, and the model should stay free to do it.
3. **An eval that measures it**, because prompt fixes that feel right and don't work are the
   norm here:

```bash
npm run eval:pushback            # four scenarios, client pushes three times each
npm run eval:pushback -- --runs 3 --show
```

Each scenario opens with something you'd say no to, then pushes three times without ever
adding a fact. A judge grades the last reply `held` / `softened` / `caved` and prints a hold
rate. Anything under 100% is real — the fix is to add the position it folded on to
`positions.md`, including what you say the third time, and run it again.

`npm test` runs the detector's unit tests and needs no API key.

## The first meeting

`persona/meeting-flow.md` holds the running order of a fact-finder, in the advisor's words —
open with their agenda ("what do you want to make sure we talk about"), then their history with
advisors and the A-to-F grade, then discovery. Two parts of a meeting can't live in a prompt,
so they're wired into the server:

- **The agenda is a promise.** What they say matters gets recorded in their own words and sits
  in the dossier every turn, marked covered or not, so nothing quietly slides off the table.
- **The twenty-minute check.** At `TIME_CHECK_MINUTES`, an operator note fires once: ask whether
  they're still okay on time or whether it's better to book another block. It carries what's been
  covered and what's still on their list, so the question can be asked with something behind it.

The grade gap — what would make their current advisor an A — is stored as the brief for the whole
relationship and rendered into every conversation after it.

## What it can actually do

Numbers never come from the model's head. It gathers inputs in conversation and calls a tool:

| Tool | What it does |
|---|---|
| `record_agenda` | Their list for today, in their words, marked covered as you go |
| `record_advisor_experience` | Status, the A-F grade, and what would make it an A |
| `save_accounts` | Everything in one place - balance, contributions, match, per bucket |
| `run_retirement_projection` | The real projection, plus any stress tests asked for |
| `draft_document` | A full draft with the attorney's checklist attached |

**The projection** (`server/retirement.js`) is a deterministic engine - year-by-year accumulation,
then a withdrawal phase that sequences taxable to pre-tax to tax-free, forces RMDs from 73 off the
IRS Uniform Lifetime Table, grosses up withdrawals for tax, and reports whether the money lasts,
what the first year costs in tax, and the mix across tax buckets at retirement. It runs live in
the meeting rather than becoming a deliverable emailed next week. Stress tests ride along: retire
at 62, markets 2% worse, spend less - each one a separate run, not a hand-wave.

Its assumptions are printed on the card and it says plainly what it doesn't model (no sequence
risk, no state tax, simplified federal treatment). The tests in `evals/retirement.test.mjs` cover
the withdrawal ordering, the RMD spill into taxable, and the case that makes the advisor's point:
same money all-Roth vs all-pre-tax pays wildly different lifetime tax, and *both* clients still
retire fine.

**Documents** (`server/documents.js`) - the model writes the language, the code enforces what
can't be left to judgment: the not-executed notice on every draft, a per-type checklist of what
the attorney has to verify, and a flag on every bracketed blank left in the text. Nothing leaves
looking executable.

**Aggregation** is manual entry today - the Money tab, or the advisor recording accounts as the
client describes them. Live aggregation (Plaid or similar) drops into the same store and the same
shape; it is a real integration with real security obligations, so it isn't stubbed out
pretending to work.

## The memory

Hit **End & remember** when a conversation is done. The transcript goes through an
extraction pass that pulls out durable facts, profile updates, open action items, and a
one-line summary, and merges them into the client's record. All of it is visible and
editable in the Memory panel, and stored as plain JSON in `data/me.json` — open it and
read it. Next conversation, that record is in the system prompt, which is what makes the
second session feel like a continuation instead of a cold start.

## Voice

- **Talking to it** — the mic button uses the browser's built-in speech recognition.
  Chrome and Safari only.
- **It talking back** — the "Speak replies" toggle. With no `ELEVENLABS_API_KEY` set it
  uses the browser's built-in voice, which is free and sounds like a GPS. With an
  ElevenLabs key and a voice you've cloned from your own recordings, it sounds like you.
- Replies are spoken sentence-by-sentence as they stream, so speech starts while the
  model is still writing. That's the difference between "responsive" and "waiting".

No video avatar. That's the right call for a feasibility test — a photoreal talking head
adds real per-minute cost and a failure mode (almost-right face) that would tell you
nothing about whether the *advice* is good.

## Knobs

`ADVISOR_EFFORT` in `.env` trades reply speed against reasoning depth: `low` is what makes
a spoken conversation feel live, `medium`/`high` is what you want when you're judging
whether the advice is actually right. Worth testing both — they're different products.

## What's deliberately not here

Multi-user auth, billing, encryption at rest, audit logging, an admin view, rate limits.
All of that is required the moment a second person logs in, and none of it is required to
answer the question this prototype exists to answer.

## Layout

```
server/
  index.js      HTTP API + SSE streaming
  claude.js     model calls (chat + memory extraction)
  prompt.js     prompt assembly — operating rules, style guide, positions, dossier
  pressure.js   detects push-back so the reply doesn't soften under it
  meeting.js    the agenda promise and the twenty-minute time check
  tools.js      what the advisor can do, as opposed to talk about
  retirement.js the projection engine - deterministic, tested, never the model's arithmetic
  documents.js  drafts, each one carrying its attorney checklist
  persona.js    loads and hot-reloads style-guide.md, positions.md, qa/*.md
  retrieval.js  BM25 search over your recorded answers
  store.js      flat-file JSON store, one file per client
evals/
  pushback.mjs  scripted pressure conversations, graded for capitulation
  pressure.test.mjs    unit tests for the detector (no API key needed)
  retirement.test.mjs  projection math
  meeting.test.mjs     the clock and the agenda
persona/        your voice — the only files you need to edit
preview.html    dev harness: the tool cards rendered with real engine output and
src/preview.jsx   no API calls (npm run dev:web, then open /preview.html)
src/            React frontend
data/           runtime storage (gitignored)
```
