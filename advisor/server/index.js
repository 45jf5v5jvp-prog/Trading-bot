import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { load, save, update, newId } from './store.js'
import { getPersona, findSimilarAnswers } from './persona.js'
import { buildSystemBlocks, buildReferenceBlock, buildPressureReminder } from './prompt.js'
import { detectPressure } from './pressure.js'
import { dueCheckpoint, buildTimeNote, elapsedMinutes, plannedMinutes, MEETING_LENGTHS, DEFAULT_MINUTES } from './meeting.js'
import { TOOLS, runTool } from './tools.js'
import { studioState, saveTake, deleteTake, recordConsent, exportDataset } from './studio.js'
import { speak, activeProvider } from './voice.js'
import { streamReply, extractMemory, MODEL } from './claude.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '1mb' }))

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY is not set — chat will fail. Copy .env.example to .env.')
}

// ---------------------------------------------------------------- auth
// Single-tenant on purpose: this is your private prototype, not a product.
// Real multi-user auth is a v2 problem, and a deliberate one — the moment other
// people can log in, everything they type has to be handled like client records.
const PASSCODE = process.env.ADVISOR_PASSCODE || 'change-me'
const tokens = new Map() // token -> userId

app.post('/api/login', (req, res) => {
  const { passcode } = req.body ?? {}
  if (passcode !== PASSCODE) return res.status(401).json({ error: 'Wrong passcode.' })
  const token = crypto.randomBytes(24).toString('hex')
  tokens.set(token, 'me')
  res.json({ token })
})

function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const userId = tokens.get(token)
  if (!userId) return res.status(401).json({ error: 'Not signed in.' })
  req.userId = userId
  next()
}

// ---------------------------------------------------------------- state
app.get('/api/me', auth, (req, res) => {
  const doc = load(req.userId)
  const persona = getPersona()
  res.json({
    profile: doc.profile,
    facts: doc.facts,
    actionItems: doc.actionItems,
    conversations: doc.conversations.map(({ messages, ...meta }) => ({
      ...meta,
      messageCount: messages.length,
    })),
    persona: {
      recordedAnswers: persona.entries.length,
      styleGuideChars: persona.styleGuide.length,
      positionsChars: persona.positions.length,
    },
    agenda: doc.agenda,
    advisorExperience: doc.advisorExperience,
    accounts: doc.accounts,
    documents: doc.documents,
    lastProjection: doc.lastProjection,
    voice: { provider: activeProvider(), cloned: Boolean(activeProvider()) },
    model: MODEL,
  })
})

app.put('/api/profile', auth, (req, res) => {
  const doc = update(req.userId, (d) => ({ ...d, profile: { ...d.profile, ...req.body } }))
  res.json({ profile: doc.profile })
})

app.patch('/api/action-items/:id', auth, (req, res) => {
  const doc = update(req.userId, (d) => {
    const item = d.actionItems.find((a) => a.id === req.params.id)
    if (item) item.status = req.body.status === 'done' ? 'done' : 'open'
    return d
  })
  res.json({ actionItems: doc.actionItems })
})

// Manual entry, for anything the client would rather type than say out loud.
// Live aggregation (Plaid and friends) plugs in here — same shape, same store.
app.put('/api/accounts', auth, (req, res) => {
  const doc = update(req.userId, (d) => ({ ...d, accounts: req.body.accounts ?? [] }))
  res.json({ accounts: doc.accounts })
})

app.patch('/api/agenda/:index', auth, (req, res) => {
  const doc = update(req.userId, (d) => {
    const item = d.agenda[Number(req.params.index)]
    if (item) item.covered = Boolean(req.body.covered)
    return d
  })
  res.json({ agenda: doc.agenda })
})

app.post('/api/conversations', auth, (req, res) => {
  const requested = Number(req.body?.plannedMinutes)
  const conversation = {
    id: newId('conv'),
    title: 'New review',
    createdAt: new Date().toISOString(),
    closedAt: null,
    summary: '',
    // The client says how long they have. The advisor works to it.
    plannedMinutes: MEETING_LENGTHS.includes(requested) ? requested : DEFAULT_MINUTES,
    checkpoints: {},
    recap: null,
    messages: [],
  }
  update(req.userId, (d) => { d.conversations.push(conversation); return d })
  res.json({ conversation })
})

// They can always buy themselves more time; the point of the clock is that the
// decision is theirs and gets made out loud.
app.post('/api/conversations/:id/extend', auth, (req, res) => {
  const minutes = Math.min(120, Math.max(5, Number(req.body?.minutes) || 15))
  const doc = update(req.userId, (d) => {
    const conv = d.conversations.find((c) => c.id === req.params.id)
    if (conv) {
      conv.plannedMinutes = plannedMinutes(conv) + minutes
      // A fresh runway means the wrap and overtime notes get to fire again.
      conv.checkpoints = { ...conv.checkpoints, wrap: null, overtime: null }
    }
    return d
  })
  const conv = doc.conversations.find((c) => c.id === req.params.id)
  res.json({ plannedMinutes: conv?.plannedMinutes })
})

app.get('/api/conversations/:id', auth, (req, res) => {
  const conversation = load(req.userId).conversations.find((c) => c.id === req.params.id)
  if (!conversation) return res.status(404).json({ error: 'No such conversation.' })
  res.json({ conversation })
})

// ---------------------------------------------------------------- chat
app.post('/api/chat', auth, async (req, res) => {
  const { conversationId, message } = req.body ?? {}
  if (!message?.trim()) return res.status(400).json({ error: 'Empty message.' })

  let doc = load(req.userId)
  const conversation = doc.conversations.find((c) => c.id === conversationId)
  if (!conversation) return res.status(404).json({ error: 'No such conversation.' })

  const persona = getPersona()
  const hits = findSimilarAnswers(message, 5)
  const reference = buildReferenceBlock(hits)

  const history = conversation.messages.map((m) => ({ role: m.role, content: m.content }))
  const userContent = reference
    ? [{ type: 'text', text: reference }, { type: 'text', text: message }]
    : message

  const turns = [...history, { role: 'user', content: userContent }]

  // Two kinds of operator note, both delivered as mid-conversation system
  // messages: they sit after the client's message, so they're the last thing read
  // before the reply is written, and they leave the cached prefix intact.
  const pressure = detectPressure({ message, history })
  if (pressure.pressured) {
    turns.push({ role: 'system', content: buildPressureReminder(pressure.signals) })
  }

  const checkpoint = dueCheckpoint(conversation)
  if (checkpoint) {
    turns.push({ role: 'system', content: buildTimeNote(checkpoint, conversation, doc.agenda) })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)

  send({
    type: 'sources',
    sources: hits.map((h) => ({ question: h.entry.question, score: +h.score.toFixed(2) })),
    pressure: pressure.signals,
    checkpoint,
    minutes: Math.round(elapsedMinutes(conversation)),
    plannedMinutes: plannedMinutes(conversation),
  })

  let reply = ''
  const usedTools = []

  try {
    const messages = [...turns]
    // Each pass is one model turn; a tool call sends us round again with the
    // result. Bounded so a confused loop can't run up a bill.
    for (let pass = 0; pass < 6; pass += 1) {
      const stream = streamReply({
        system: buildSystemBlocks({
          styleGuide: persona.styleGuide,
          positions: persona.positions,
          meetingFlow: persona.meetingFlow,
          doc,
          conversation,
        }),
        messages,
        tools: TOOLS,
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          reply += event.delta.text
          send({ type: 'text', text: event.delta.text })
        }
      }

      const final = await stream.finalMessage()
      send({ type: 'usage', usage: {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
      } })

      if (final.stop_reason === 'refusal') {
        send({ type: 'error', error: 'The model declined to answer that one.' })
        break
      }
      if (final.stop_reason !== 'tool_use') break

      messages.push({ role: 'assistant', content: final.content })

      const results = []
      for (const block of final.content.filter((b) => b.type === 'tool_use')) {
        send({ type: 'tool_start', name: block.name })
        const result = runTool({ name: block.name, input: block.input, doc })
        doc = save(doc) // tools mutate the client record; persist before continuing
        usedTools.push({ name: block.name, result })
        send({ type: 'tool', name: block.name, input: block.input, result })
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
          is_error: Boolean(result?.error),
        })
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (err) {
    console.error('[chat]', err)
    send({ type: 'error', error: err.message })
  }

  if (reply.trim()) {
    update(req.userId, (d) => {
      const conv = d.conversations.find((c) => c.id === conversationId)
      const now = new Date().toISOString()
      conv.messages.push({ role: 'user', content: message, ts: now })
      conv.messages.push({ role: 'assistant', content: reply, ts: now, tools: usedTools.map((t) => t.name) })
      if (checkpoint) conv.checkpoints = { ...(conv.checkpoints ?? {}), [checkpoint]: now }
      return d
    })
  }

  send({ type: 'done' })
  res.end()
})

// ---------------------------------------------------------------- memory
// Called when a conversation ends. This is what makes the next login feel like a
// continuation rather than a cold start.
app.post('/api/conversations/:id/close', auth, async (req, res) => {
  const doc = load(req.userId)
  const conversation = doc.conversations.find((c) => c.id === req.params.id)
  if (!conversation) return res.status(404).json({ error: 'No such conversation.' })
  if (conversation.messages.length < 2) return res.json({ skipped: 'Nothing to remember yet.' })

  let extracted
  try {
    extracted = await extractMemory({ conversation, doc })
  } catch (err) {
    console.error('[memory]', err)
    return res.status(502).json({ error: err.message })
  }
  if (!extracted) return res.status(502).json({ error: 'Could not read back the memory update.' })

  const now = new Date().toISOString()
  const updated = update(req.userId, (d) => {
    const conv = d.conversations.find((c) => c.id === req.params.id)
    conv.summary = extracted.summary ?? ''
    conv.title = extracted.title || conv.title
    conv.closedAt = now
    conv.recap = {
      highlights: extracted.highlights ?? [],
      advisorActions: extracted.advisorActions ?? [],
      clientHomework: extracted.clientHomework ?? [],
      minutes: Math.round(elapsedMinutes(conv)),
    }

    const known = new Set(d.facts.map((f) => f.text.toLowerCase()))
    for (const text of extracted.newFacts ?? []) {
      if (!known.has(text.toLowerCase())) {
        d.facts.push({ id: newId('fact'), text, source: conv.id, createdAt: now })
      }
    }

    d.profile = { ...d.profile, ...(extracted.profileUpdates ?? {}) }

    const openText = new Set(d.actionItems.filter((a) => a.status === 'open').map((a) => a.text.toLowerCase()))
    for (const text of extracted.newActionItems ?? []) {
      if (!openText.has(text.toLowerCase())) {
        d.actionItems.push({ id: newId('item'), text, status: 'open', createdAt: now })
      }
    }
    for (const text of extracted.completedActionItems ?? []) {
      const item = d.actionItems.find((a) => a.text.toLowerCase() === text.toLowerCase())
      if (item) item.status = 'done'
    }
    return d
  })

  const closed = updated.conversations.find((c) => c.id === req.params.id)
  res.json({
    summary: closed.summary,
    recap: closed.recap,
    facts: updated.facts,
    actionItems: updated.actionItems,
    profile: updated.profile,
  })
})

// ---------------------------------------------------------------- studio
// Recording your own voice and likeness. Takes are written to this machine's
// disk and nowhere else.
app.get('/api/studio', auth, (req, res) => res.json(studioState()))

app.post('/api/studio/consent', auth, (req, res) => {
  const { name, statement } = req.body ?? {}
  if (!name?.trim()) return res.status(400).json({ error: 'A name is required.' })
  res.json({ consent: recordConsent({ name: name.trim(), statement }) })
})

app.post('/api/studio/take',
  express.raw({ type: ['video/webm', 'audio/webm', 'application/octet-stream'], limit: '250mb' }),
  (req, res, next) => auth(req, res, next),
  (req, res) => {
    const meta = {
      kind: req.query.kind === 'video' ? 'video' : 'voice',
      scriptId: String(req.query.scriptId ?? 'unknown'),
      lineIndex: Number(req.query.lineIndex ?? 0),
      text: String(req.query.text ?? ''),
      direction: req.query.direction ? String(req.query.direction) : null,
      durationMs: Number(req.query.durationMs ?? 0),
      quality: req.query.quality ? JSON.parse(String(req.query.quality)) : {},
    }
    if (!req.body?.length) return res.status(400).json({ error: 'Empty recording.' })
    res.json({ take: saveTake({ buffer: req.body, meta }) })
  })

app.delete('/api/studio/take/:id', auth, (req, res) => {
  const result = deleteTake(req.params.id)
  res.status(result.error ? 404 : 200).json(result)
})

app.post('/api/studio/export', auth, (req, res) => {
  const result = exportDataset()
  res.status(result.error ? 400 : 200).json(result)
})

// ---------------------------------------------------------------- voice
// Optional. With an ElevenLabs key the reply comes back in a cloned voice; without
// one the browser falls back to its built-in speech synthesis.
app.post('/api/tts', auth, async (req, res) => {
  const { text } = req.body ?? {}
  if (!text?.trim()) return res.status(400).json({ error: 'Nothing to say.' })

  const result = await speak(text)
  if (result.error) return res.status(503).json({ error: result.error })
  res.setHeader('Content-Type', result.contentType)
  res.end(result.audio)
})

// ---------------------------------------------------------------- serve
const dist = path.join(here, '..', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const port = process.env.PORT || 8787
app.listen(port, () => {
  getPersona()
  console.log(`[advisor] http://localhost:${port}  (model: ${MODEL})`)
})
