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

Two files, both under `persona/`:

- **`style-guide.md`** — your judgment, in first person. Currently a template with prompts
  in it. Replace it entirely. This gets loaded into every conversation.
- **`qa/*.md`** — your actual answers to actual questions. Four samples ship as a format
  demo; delete them and put your own in. See `persona/README.md` for the format and for
  the fastest way to build the corpus (talk, transcribe, paste).

Both reload when the files change — edit and send another message, no restart.

At answer time the app pulls the five recorded answers closest to what was asked (BM25
over your corpus) and shows them to the model alongside your style guide. The chat panel
has a "show the recorded answers this drew on" toggle so you can see exactly which of
your answers shaped a reply — that's the fastest way to find the gaps in your corpus.

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
  prompt.js     prompt assembly — operating rules, style guide, client dossier
  persona.js    loads and hot-reloads style-guide.md + qa/*.md
  retrieval.js  BM25 search over your recorded answers
  store.js      flat-file JSON store, one file per client
persona/        your voice — the only files you need to edit
src/            React frontend
data/           runtime storage (gitignored)
```
