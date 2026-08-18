// Flat-file JSON store. One file per client. Deliberately simple: for a private
// prototype you want to be able to open the file and read what the AI thinks it
// knows. Swap for Postgres if this ever becomes real.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(here, '..', 'data')

fs.mkdirSync(DATA_DIR, { recursive: true })

const blank = (id) => ({
  id,
  createdAt: new Date().toISOString(),
  profile: {},
  facts: [],          // durable things learned about the client
  actionItems: [],    // { id, text, status: 'open' | 'done', createdAt }
  agenda: [],         // what they said mattered today — { text, covered }
  advisorExperience: null,
  accounts: [],       // everything in one place — { label, bucket, balance, ... }
  documents: [],      // drafts, each carrying its attorney checklist
  lastProjection: null,
  conversations: [],  // { id, title, createdAt, closedAt, summary, messages[] }
})

const fileFor = (id) => path.join(DATA_DIR, `${id.replace(/[^a-z0-9_-]/gi, '')}.json`)

export function load(id) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return blank(id)
  try {
    return { ...blank(id), ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (err) {
    console.error(`[store] ${file} is corrupt, starting fresh:`, err.message)
    return blank(id)
  }
}

export function save(doc) {
  const file = fileFor(doc.id)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2))
  fs.renameSync(tmp, file) // atomic-ish; never leaves a half-written file
  return doc
}

export function update(id, fn) {
  const doc = load(id)
  const next = fn(doc) ?? doc
  return save(next)
}

export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
