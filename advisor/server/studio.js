// The recording studio.
//
// This is the part of an avatar that is genuinely proprietary: the corpus of you.
// Whatever engine ends up rendering the face and the voice — a hosted API today,
// your own weights on your own GPUs later — it is trained or conditioned on this
// data. The data is the asset. Everything here writes it to your own disk in a
// layout that standard training pipelines read, so switching engines is a
// re-training job rather than a re-collection job.
//
// Nothing in this file talks to a third party.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = path.join(here, '..', 'data', 'media')
const DATASET_DIR = path.join(here, '..', 'data', 'dataset')
const MANIFEST = path.join(MEDIA_DIR, 'manifest.json')

// Called before every write rather than once at import: the directory can be
// removed or the volume remounted while the server is up, and a lost recording
// is not a recoverable mistake.
const ensureMediaDir = () => fs.mkdirSync(MEDIA_DIR, { recursive: true })
ensureMediaDir()

// What a usable dataset looks like. These are the numbers the open-source voice
// and talking-head pipelines actually want — not a guess, and worth checking
// against whichever model you land on before you record for three hours.
export const TARGETS = {
  voice: { minutes: 20, label: 'clean speech', note: 'Enough to fine-tune a voice model. More is better; 60+ minutes is where quality stops improving quickly.' },
  video: { minutes: 5, label: 'frontal video', note: 'Even lighting, same position, mouth clearly visible. A still 60-second listening loop matters as much as the talking.' },
}

// Scripts are grouped so the corpus covers the ground a voice model needs: broad
// phonetic coverage, the words you actually say, and the full range of how you
// say them. The last group is the one people skip, and it's the one that decides
// whether your clone can deliver bad news.
export const SCRIPTS = [
  {
    id: 'phonetic',
    kind: 'voice',
    title: 'Phonetic coverage',
    why: 'Public-domain sentences chosen to cover the sounds of English evenly. Read them plainly.',
    lines: [
      'The birch canoe slid on the smooth planks.',
      'Glue the sheet to the dark blue background.',
      "It's easy to tell the depth of a well.",
      'These days a chicken leg is a rare dish.',
      'Rice is often served in round bowls.',
      'The juice of lemons makes fine punch.',
      'The box was thrown beside the parked truck.',
      'The hogs were fed chopped corn and garbage.',
      'Four hours of steady work faced us.',
      'A large size in stockings is hard to sell.',
      'The boy was there when the sun rose.',
      'A rod is used to catch pink salmon.',
      'The source of the huge river is the clear spring.',
      'Kick the ball straight and follow through.',
      'Help the woman get back to her feet.',
      'A pot of tea helps to pass the evening.',
      'Smoky fires lack flame and heat.',
      'The soft cushion broke the mans fall.',
      'The salt breeze came across from the sea.',
      'The girl at the booth sold fifty bonds.',
    ],
  },
  {
    id: 'vocabulary',
    kind: 'voice',
    title: 'Your vocabulary',
    why: 'The words and numbers you say every week. A model that has never heard you say "Roth conversion" will mangle it.',
    lines: [
      'Your emergency fund is the shock absorber, not the engine.',
      'We are looking at a Roth conversion in a year where your income is unusually low.',
      'The required minimum distribution starts at seventy-three, whether you need the money or not.',
      'That is a guaranteed seven percent, and there is not much I can offer you that beats a guaranteed seven percent.',
      'Between the four-oh-one-k, the Roth, the brokerage account and the cash value policy, we have four different tax treatments to work with.',
      'Your effective rate in retirement is closer to twelve percent than the twenty-two you are picturing.',
      'We are projecting two point five percent inflation and a six and a half percent return before retirement.',
      'The sequence of returns matters more in the first five years than it ever will again.',
      'A beneficiary designation overrides your will, every time.',
      'That is a question for your CPA, and I would want to see the actual return before I answered it.',
    ],
  },
  {
    id: 'range',
    kind: 'voice',
    title: 'How you say it',
    why: 'Same person, different rooms. This is what lets the clone reassure someone and also tell them no — record each line the way you would actually say it.',
    lines: [
      { direction: 'Reassuring — someone is frightened', text: 'Nothing about your life changed this week. Your timeline did not change, your income did not change. The only thing that changed is a number on a screen.' },
      { direction: 'Firm — you are saying no', text: 'I am not going to tell you that is a reasonable call, because I do not think it is. I will help you do the least damage, and I still think you should not do it.' },
      { direction: 'Explaining a number', text: 'Take what you spend in a year, subtract what Social Security covers, and multiply what is left by twenty-five. That is your first target.' },
      { direction: 'Delivering something they did not want to hear', text: 'At the rate you are saving now, the money runs out around eighty-three. I would rather tell you that at fifty-five than at seventy.' },
      { direction: 'Warm — opening a meeting', text: 'Good to finally sit down with you. Before we get into anything specific, tell me what is on your mind.' },
      { direction: 'Light — a joke lands', text: 'That is the kind of parent who ends up moving in with their daughter at seventy-five. I am being a little dramatic. Only a little.' },
    ],
  },
  {
    id: 'presence',
    kind: 'video',
    title: 'On camera',
    why: 'Sit where you would sit for a client meeting. Even lighting on your face, same distance, same background for every take.',
    lines: [
      { direction: 'Listening — say nothing, look at the camera, small natural movements', text: '(Silence. Sixty seconds. This take is what plays while the client is talking, so it matters more than it looks.)' },
      { direction: 'Talking naturally to the camera', text: 'Tell the story of how you got into this work, as if the person across from you just asked. Two minutes, unscripted.' },
      { direction: 'Explaining, with your hands as you normally use them', text: 'Walk through the four buckets and why having money in more than one of them is the whole point.' },
      { direction: 'Nodding and reacting, no speech', text: '(React the way you do when a client is telling you something difficult. Thirty seconds.)' },
      { direction: 'Saying no, on camera', text: 'I would hold. And I want to tell you why, because the reason matters more than the answer.' },
    ],
  },
]

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return { takes: [], consent: null }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  } catch {
    return { takes: [], consent: null }
  }
}

function writeManifest(data) {
  ensureMediaDir()
  fs.writeFileSync(MANIFEST, JSON.stringify(data, null, 2))
  return data
}

export function studioState() {
  const manifest = readManifest()
  const totals = { voice: 0, video: 0 }
  for (const take of manifest.takes) {
    totals[take.kind] = (totals[take.kind] ?? 0) + (take.durationMs ?? 0)
  }
  return {
    scripts: SCRIPTS,
    targets: TARGETS,
    takes: manifest.takes,
    consent: manifest.consent,
    progress: {
      voice: { minutes: +(totals.voice / 60000).toFixed(1), target: TARGETS.voice.minutes },
      video: { minutes: +(totals.video / 60000).toFixed(1), target: TARGETS.video.minutes },
    },
  }
}

export function saveTake({ buffer, meta }) {
  ensureMediaDir()
  const id = `${meta.kind}_${meta.scriptId}_${meta.lineIndex}_${Date.now().toString(36)}`
  const file = path.join(MEDIA_DIR, `${id}.webm`)
  fs.writeFileSync(file, buffer)

  const manifest = readManifest()
  const take = {
    id,
    file: `${id}.webm`,
    kind: meta.kind,
    scriptId: meta.scriptId,
    lineIndex: meta.lineIndex,
    text: meta.text,
    direction: meta.direction ?? null,
    durationMs: meta.durationMs ?? 0,
    bytes: buffer.length,
    quality: meta.quality ?? {},
    recordedAt: new Date().toISOString(),
  }
  manifest.takes.push(take)
  writeManifest(manifest)
  return take
}

export function deleteTake(id) {
  const manifest = readManifest()
  const take = manifest.takes.find((t) => t.id === id)
  if (!take) return { error: 'No such take.' }
  const file = path.join(MEDIA_DIR, take.file)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  manifest.takes = manifest.takes.filter((t) => t.id !== id)
  writeManifest(manifest)
  return { deleted: id }
}

// A dated record that the person in the recordings agreed to their likeness and
// voice being used this way. It costs nothing to have and is the first thing
// anyone buying this company will ask for.
export function recordConsent({ name, statement }) {
  const manifest = readManifest()
  manifest.consent = {
    name,
    statement,
    agreedAt: new Date().toISOString(),
  }
  writeManifest(manifest)
  return manifest.consent
}

// Writes the corpus out in the layout training pipelines expect. Voice goes to
// an LJSpeech-style folder (wavs + metadata.csv), which nearly every open-source
// TTS trainer reads directly. If ffmpeg is on the machine the audio is
// transcoded to 22.05kHz mono wav; if it isn't, the webm files are copied as-is
// and the summary says so rather than leaving you to find out later.
export function exportDataset() {
  const manifest = readManifest()
  if (!manifest.takes.length) return { error: 'Nothing recorded yet.' }

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

  const voiceDir = path.join(DATASET_DIR, 'voice')
  const wavDir = path.join(voiceDir, 'wavs')
  const videoDir = path.join(DATASET_DIR, 'video')
  fs.mkdirSync(wavDir, { recursive: true })
  fs.mkdirSync(videoDir, { recursive: true })

  const rows = []
  let converted = 0
  let copied = 0

  for (const take of manifest.takes) {
    const source = path.join(MEDIA_DIR, take.file)
    if (!fs.existsSync(source)) continue

    if (take.kind === 'voice') {
      if (hasFfmpeg) {
        const out = path.join(wavDir, `${take.id}.wav`)
        const result = spawnSync('ffmpeg', ['-y', '-i', source, '-ar', '22050', '-ac', '1', out], { stdio: 'ignore' })
        if (result.status === 0) converted += 1
        else { fs.copyFileSync(source, path.join(wavDir, take.file)); copied += 1 }
      } else {
        fs.copyFileSync(source, path.join(wavDir, take.file))
        copied += 1
      }
      // LJSpeech format: id|raw text|normalized text
      rows.push(`${take.id}|${take.text.replace(/\|/g, ' ')}|${take.text.replace(/\|/g, ' ')}`)
    } else {
      fs.copyFileSync(source, path.join(videoDir, take.file))
    }
  }

  fs.writeFileSync(path.join(voiceDir, 'metadata.csv'), `${rows.join('\n')}\n`)
  fs.writeFileSync(path.join(DATASET_DIR, 'takes.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(DATASET_DIR, 'README.md'), datasetReadme({ hasFfmpeg, rows: rows.length }))

  return {
    path: DATASET_DIR,
    voiceClips: rows.length,
    videoClips: manifest.takes.filter((t) => t.kind === 'video').length,
    audioConverted: converted,
    audioCopiedRaw: copied,
    ffmpeg: hasFfmpeg,
    note: hasFfmpeg
      ? 'Audio transcoded to 22.05kHz mono wav.'
      : 'ffmpeg not found — audio was copied as webm. Install ffmpeg and export again before training.',
  }
}

const datasetReadme = ({ hasFfmpeg, rows }) => `# Voice and likeness corpus

Recorded locally. Nothing here has been sent to any third party.

\`\`\`
voice/
  wavs/            one file per take
  metadata.csv     LJSpeech format: id|text|text  (${rows} clips)
video/             one file per take
takes.json         full manifest — durations, quality measures, consent record
\`\`\`

${hasFfmpeg
  ? 'Audio is 22.05kHz mono wav, which is what most open-source TTS trainers expect.'
  : '**ffmpeg was not installed when this was exported**, so audio is still webm. Install it and export again before training on this.'}

## Using it

The layout is deliberately generic. Voice cloning and talking-head pipelines that
read LJSpeech-style folders can train on \`voice/\` without modification. \`video/\`
holds the frontal takes for whichever face model you choose.

Check the licence of any model you train before it goes anywhere near a paying
customer — several of the best open-source voice and avatar models are released
for research use only, which makes them unusable in a product you intend to sell.
That constraint decides which model you pick, so check it first, not last.
`
