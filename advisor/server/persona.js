// Loads the two things that make the AI sound like you:
//   persona/style-guide.md  — how you talk, what you believe, what you refuse to do
//   persona/positions.md    — where you don't move, and what you say when pushed
//   persona/qa/*.md         — transcripts of you actually answering questions
// Both are re-read when they change on disk, so you can edit and reload without
// restarting the server.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex } from './retrieval.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PERSONA_DIR = path.join(here, '..', 'persona')
const QA_DIR = path.join(PERSONA_DIR, 'qa')

let cache = null

function parseQaFile(text, file) {
  return text
    .split(/^---+$/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const match = block.match(/^Q:\s*([\s\S]+?)\n\s*A:\s*([\s\S]+)$/)
      if (!match) return null
      let [, question, answer] = match
      let tags = []
      const tagLine = answer.match(/\n\s*Tags:\s*(.+)\s*$/)
      if (tagLine) {
        tags = tagLine[1].split(',').map((t) => t.trim()).filter(Boolean)
        answer = answer.slice(0, tagLine.index)
      }
      return { question: question.trim(), answer: answer.trim(), tags, file }
    })
    .filter(Boolean)
}

function fingerprint() {
  const files = [path.join(PERSONA_DIR, 'style-guide.md'), path.join(PERSONA_DIR, 'positions.md')]
  if (fs.existsSync(QA_DIR)) {
    for (const name of fs.readdirSync(QA_DIR)) {
      if (name.endsWith('.md')) files.push(path.join(QA_DIR, name))
    }
  }
  return files
    .filter((f) => fs.existsSync(f))
    .map((f) => `${f}:${fs.statSync(f).mtimeMs}`)
    .join('|')
}

export function getPersona() {
  const stamp = fingerprint()
  if (cache?.stamp === stamp) return cache

  const read = (name) => {
    const file = path.join(PERSONA_DIR, name)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const styleGuide = read('style-guide.md')
  const positions = read('positions.md')

  const entries = []
  if (fs.existsSync(QA_DIR)) {
    for (const name of fs.readdirSync(QA_DIR).sort()) {
      if (!name.endsWith('.md')) continue
      entries.push(...parseQaFile(fs.readFileSync(path.join(QA_DIR, name), 'utf8'), name))
    }
  }

  cache = { stamp, styleGuide, positions, entries, index: buildIndex(entries) }
  console.log(`[persona] loaded ${entries.length} recorded answers, `
    + `${styleGuide.length} chars of style guide, ${positions.length} chars of positions`)
  return cache
}

export function findSimilarAnswers(query, limit = 5) {
  return getPersona().index.search(query, limit)
}
