import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { load, save, update, newId } from './store.js'
import { getPersona, findSimilarAnswers } from './persona.js'
import { buildSystemBlocks, buildReferenceBlock } from './prompt.js'
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
    persona: { recordedAnswers: persona.entries.length, styleGuideChars: persona.styleGuide.length },
    voice: { cloned: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) },
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

app.post('/api/conversations', auth, (req, res) => {
  const conversation = {
    id: newId('conv'),
    title: 'New review',
    createdAt: new Date().toISOString(),
    closedAt: null,
    summary: '',
    messages: [],
  }
  update(req.userId, (d) => { d.conversations.push(conversation); return d })
  res.json({ conversation })
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

  const doc = load(req.userId)
  const conversation = doc.conversations.find((c) => c.id === conversationId)
  if (!conversation) return res.status(404).json({ error: 'No such conversation.' })

  const persona = getPersona()
  const hits = findSimilarAnswers(message, 5)
  const reference = buildReferenceBlock(hits)

  const history = conversation.messages.map((m) => ({ role: m.role, content: m.content }))
  const userContent = reference
    ? [{ type: 'text', text: reference }, { type: 'text', text: message }]
    : message

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)

  send({ type: 'sources', sources: hits.map((h) => ({ question: h.entry.question, score: +h.score.toFixed(2) })) })

  let reply = ''
  try {
    const stream = streamReply({
      system: buildSystemBlocks({ styleGuide: persona.styleGuide, doc }),
      messages: [...history, { role: 'user', content: userContent }],
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        reply += event.delta.text
        send({ type: 'text', text: event.delta.text })
      }
    }

    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal') {
      send({ type: 'error', error: 'The model declined to answer that one.' })
    }
    send({ type: 'usage', usage: {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
    } })
  } catch (err) {
    console.error('[chat]', err)
    send({ type: 'error', error: err.message })
  }

  if (reply.trim()) {
    update(req.userId, (d) => {
      const conv = d.conversations.find((c) => c.id === conversationId)
      const now = new Date().toISOString()
      conv.messages.push({ role: 'user', content: message, ts: now })
      conv.messages.push({ role: 'assistant', content: reply, ts: now })
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

  res.json({
    summary: updated.conversations.find((c) => c.id === req.params.id).summary,
    facts: updated.facts,
    actionItems: updated.actionItems,
    profile: updated.profile,
  })
})

// ---------------------------------------------------------------- voice
// Optional. With an ElevenLabs key the reply comes back in a cloned voice; without
// one the browser falls back to its built-in speech synthesis.
app.post('/api/tts', auth, async (req, res) => {
  const { text } = req.body ?? {}
  const key = process.env.ELEVENLABS_API_KEY
  const voice = process.env.ELEVENLABS_VOICE_ID
  if (!key || !voice) return res.status(503).json({ error: 'No cloned voice configured.' })

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5', // lowest-latency model; quality models add ~1s
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        }),
      },
    )
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: await upstream.text() })
    }
    res.setHeader('Content-Type', 'audio/mpeg')
    const buffer = Buffer.from(await upstream.arrayBuffer())
    res.end(buffer)
  } catch (err) {
    console.error('[tts]', err)
    res.status(502).json({ error: err.message })
  }
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
