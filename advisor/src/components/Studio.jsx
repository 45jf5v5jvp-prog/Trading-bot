import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getToken } from '../lib/api.js'

// The recording booth. Camera and microphone go straight to your own server —
// there is no third party in this path, and the files never leave the machine
// the server runs on.

const request = async (path, options = {}) => {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${getToken()}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export default function Studio({ onBack }) {
  const [state, setState] = useState(null)
  const [scriptId, setScriptId] = useState('phonetic')
  const [lineIndex, setLineIndex] = useState(0)
  const [error, setError] = useState(null)
  const [exported, setExported] = useState(null)

  const load = async () => {
    try {
      setState(await request('/studio'))
    } catch (err) {
      setError(err.message)
    }
  }
  useEffect(() => { load() }, [])

  const script = state?.scripts.find((s) => s.id === scriptId)
  const line = script?.lines[lineIndex]
  const text = typeof line === 'string' ? line : line?.text ?? ''
  const direction = typeof line === 'string' ? null : line?.direction ?? null

  if (!state) return <div className="studio"><p className="muted">{error ?? 'Loading…'}</p></div>
  if (!state.consent) return <Consent onDone={load} onBack={onBack} />

  const takesForLine = state.takes.filter(
    (t) => t.scriptId === scriptId && t.lineIndex === lineIndex)

  return (
    <div className="studio">
      <header className="studio-head">
        <div>
          <h1>Recording booth</h1>
          <p className="muted">
            Everything is written to your own disk. Nothing is uploaded anywhere else.
          </p>
        </div>
        <button className="ghost" onClick={onBack}>Back to the app</button>
      </header>

      <div className="progress-row">
        {['voice', 'video'].map((kind) => {
          const p = state.progress[kind]
          const pct = Math.min(100, (p.minutes / p.target) * 100)
          return (
            <div className="progress" key={kind}>
              <div className="progress-label">
                <span>{state.targets[kind].label}</span>
                <b>{p.minutes} / {p.target} min</b>
              </div>
              <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
              <p className="muted small">{state.targets[kind].note}</p>
            </div>
          )
        })}
      </div>

      <nav className="script-tabs">
        {state.scripts.map((s) => (
          <button
            key={s.id}
            className={s.id === scriptId ? 'on' : ''}
            onClick={() => { setScriptId(s.id); setLineIndex(0) }}
          >
            {s.title}<span className="kind">{s.kind}</span>
          </button>
        ))}
      </nav>

      <p className="why">{script.why}</p>

      <Booth
        key={`${scriptId}:${lineIndex}`}
        kind={script.kind}
        scriptId={scriptId}
        lineIndex={lineIndex}
        text={text}
        direction={direction}
        takes={takesForLine}
        onSaved={load}
        onError={setError}
      />

      <div className="line-nav">
        <button className="ghost" disabled={lineIndex === 0} onClick={() => setLineIndex((i) => i - 1)}>
          Previous
        </button>
        <span className="muted">{lineIndex + 1} of {script.lines.length}</span>
        <button
          className="ghost"
          disabled={lineIndex >= script.lines.length - 1}
          onClick={() => setLineIndex((i) => i + 1)}
        >
          Next line
        </button>
      </div>

      <ol className="line-list">
        {script.lines.map((l, i) => {
          const done = state.takes.some((t) => t.scriptId === scriptId && t.lineIndex === i)
          return (
            <li key={i} className={`${i === lineIndex ? 'current' : ''} ${done ? 'done' : ''}`}>
              <button onClick={() => setLineIndex(i)}>
                {typeof l === 'string' ? l : l.text}
              </button>
            </li>
          )
        })}
      </ol>

      <footer className="studio-foot">
        <button
          className="primary"
          onClick={async () => {
            try { setExported(await request('/studio/export', { method: 'POST' })) }
            catch (err) { setError(err.message) }
          }}
        >
          Export the corpus
        </button>
        {exported && (
          <p className="muted small">
            {exported.voiceClips} voice clips, {exported.videoClips} video clips →{' '}
            <code>{exported.path}</code>. {exported.note}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </footer>
    </div>
  )
}

function Consent({ onDone, onBack }) {
  const [name, setName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState(null)
  const statement = 'I am the person recorded in these files. I agree to my voice and likeness '
    + 'being used to build and operate a synthetic version of me for this product, and I '
    + 'understand these recordings are stored on my own systems.'

  return (
    <div className="studio">
      <div className="sheet-card" style={{ margin: '3rem auto' }}>
        <h2>Before you record</h2>
        <p className="muted">{statement}</p>
        <label className="field">
          Your full name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="consent-check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          I agree, and I am dating this record today.
        </label>
        <button
          className="primary wide"
          disabled={!name.trim() || !agreed}
          onClick={async () => {
            try {
              await request('/studio/consent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, statement }),
              })
              onDone()
            } catch (err) {
              setError(err.message)
            }
          }}
        >
          Record consent and continue
        </button>
        {error && <p className="error">{error}</p>}
        <button className="link" onClick={onBack}>Back</button>
      </div>
    </div>
  )
}

// Browsers disagree about codecs; take the best one this browser admits to
// supporting and let MediaRecorder choose if none of them match.
function pickFormat(kind) {
  const candidates = kind === 'video'
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm']
  const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported?.(type))
  return mimeType ? { mimeType } : undefined
}

function Booth({ kind, scriptId, lineIndex, text, direction, takes, onSaved, onError }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const metricsRef = useRef(null)
  const rafRef = useRef(null)

  const [ready, setReady] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [lastQuality, setLastQuality] = useState(null)
  const [saving, setSaving] = useState(false)

  // Camera and mic are opened per line so switching between a voice script and a
  // video script doesn't leave a camera light on for no reason.
  useEffect(() => {
    let cancelled = false
    async function open() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          kind === 'video'
            ? { audio: { echoCancellation: false, noiseSuppression: false }, video: { width: 1280, height: 720 } }
            : { audio: { echoCancellation: false, noiseSuppression: false } },
        )
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current && kind === 'video') videoRef.current.srcObject = stream
        setReady(true)
      } catch (err) {
        onError(`Couldn't open the ${kind === 'video' ? 'camera' : 'microphone'}: ${err.message}`)
      }
    }
    open()
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [kind, onError])

  function startMetrics() {
    const audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(streamRef.current)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    const buffer = new Float32Array(analyser.fftSize)

    const metrics = {
      audioContext, peak: 0, clippedFrames: 0, quietFrames: 0, frames: 0,
      luma: [], motion: [], lastFrame: null, lastVideoSample: 0,
    }

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer)
      let peak = 0
      let sum = 0
      for (const sample of buffer) {
        const abs = Math.abs(sample)
        if (abs > peak) peak = abs
        sum += sample * sample
      }
      const rms = Math.sqrt(sum / buffer.length)
      metrics.frames += 1
      metrics.peak = Math.max(metrics.peak, peak)
      if (peak > 0.98) metrics.clippedFrames += 1
      if (rms < 0.005) metrics.quietFrames += 1
      setLevel(Math.min(1, rms * 6))

      // Video is sampled a few times a second — enough to catch bad lighting or
      // someone drifting out of frame, cheap enough not to drop frames.
      if (kind === 'video' && videoRef.current && performance.now() - metrics.lastVideoSample > 400) {
        metrics.lastVideoSample = performance.now()
        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height)
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let luma = 0
        for (let i = 0; i < data.length; i += 4) {
          luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
        }
        luma /= data.length / 4
        metrics.luma.push(luma)
        if (metrics.lastFrame) {
          let diff = 0
          for (let i = 0; i < data.length; i += 16) diff += Math.abs(data[i] - metrics.lastFrame[i])
          metrics.motion.push(diff / (data.length / 16))
        }
        metrics.lastFrame = new Uint8ClampedArray(data)
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
    metricsRef.current = metrics
  }

  function finishMetrics(durationMs) {
    cancelAnimationFrame(rafRef.current)
    const m = metricsRef.current
    if (!m) return {}
    m.audioContext.close()

    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
    const lumaMean = mean(m.luma)
    const lumaSpread = m.luma.length
      ? Math.sqrt(mean(m.luma.map((v) => (v - lumaMean) ** 2)))
      : 0

    const quality = {
      peak: +m.peak.toFixed(3),
      clipped: m.clippedFrames > 3,
      silenceRatio: +(m.quietFrames / Math.max(1, m.frames)).toFixed(2),
      durationMs,
      ...(kind === 'video' ? {
        brightness: Math.round(lumaMean),
        lightingSpread: Math.round(lumaSpread),
        motion: +mean(m.motion).toFixed(1),
      } : {}),
    }

    quality.warnings = [
      quality.clipped && 'Too loud — the signal is clipping. Back off the mic or lower the input.',
      quality.peak < 0.08 && 'Too quiet to train on. Move closer or raise the input.',
      quality.silenceRatio > 0.55 && 'Mostly silence. Re-take unless this is a listening clip.',
      durationMs < 1200 && 'Too short to be useful.',
      kind === 'video' && quality.brightness < 55 && 'Underexposed — put more light on your face.',
      kind === 'video' && quality.brightness > 205 && 'Blown out — too much light or a bright window behind you.',
      kind === 'video' && quality.lightingSpread > 22 && 'The light is changing during the take. Keep it steady.',
      kind === 'video' && quality.motion > 26 && 'A lot of movement. Sit still and keep the framing constant.',
    ].filter(Boolean)

    return quality
  }

  function start() {
    if (!streamRef.current) return
    chunksRef.current = []
    const recorder = new MediaRecorder(streamRef.current, pickFormat(kind))
    recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
    const startedAt = performance.now()

    recorder.onstop = async () => {
      const durationMs = Math.round(performance.now() - startedAt)
      const quality = finishMetrics(durationMs)
      setLastQuality(quality)
      setLevel(0)
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })

      setSaving(true)
      try {
        const params = new URLSearchParams({
          kind, scriptId, lineIndex: String(lineIndex), text,
          durationMs: String(durationMs), quality: JSON.stringify(quality),
        })
        if (direction) params.set('direction', direction)
        await request(`/studio/take?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': kind === 'video' ? 'video/webm' : 'audio/webm' },
          body: blob,
        })
        onSaved()
      } catch (err) {
        onError(err.message)
      } finally {
        setSaving(false)
      }
    }

    recorderRef.current = recorder
    startMetrics()
    recorder.start()
    setRecording(true)
    setSeconds(0)
  }

  function stop() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  useEffect(() => {
    if (!recording) return undefined
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [recording])

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <div className="booth">
      <div className="stage-area">
        {kind === 'video' ? (
          <>
            <video ref={videoRef} autoPlay muted playsInline className="preview" />
            <canvas ref={canvasRef} width={160} height={90} style={{ display: 'none' }} />
          </>
        ) : (
          <div className="preview audio-only">
            <div className="meter"><div className="meter-fill" style={{ width: `${level * 100}%` }} /></div>
            <p className="muted small">Microphone only — the camera stays off for voice takes.</p>
          </div>
        )}

        <div className="teleprompter">
          {direction && <span className="direction">{direction}</span>}
          <p>{text}</p>
        </div>
      </div>

      <div className="booth-controls">
        {!recording
          ? <button className="primary" disabled={!ready || saving} onClick={start}>
              {saving ? 'Saving…' : 'Record'}
            </button>
          : <button className="recording" onClick={stop}>Stop · {mmss}</button>}
        {kind === 'video' && recording && <div className="meter thin"><div className="meter-fill" style={{ width: `${level * 100}%` }} /></div>}
        <span className="muted small">
          {takes.length ? `${takes.length} take${takes.length === 1 ? '' : 's'} on this line` : 'No takes yet'}
        </span>
      </div>

      {lastQuality?.warnings?.length > 0 && (
        <ul className="gaps">{lastQuality.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
      {lastQuality && !lastQuality.warnings.length && (
        <p className="clean">Clean take — peak {lastQuality.peak}, {Math.round(lastQuality.durationMs / 1000)}s.</p>
      )}

      {takes.length > 0 && (
        <ul className="take-list">
          {takes.map((take) => (
            <li key={take.id}>
              <span>{Math.round(take.durationMs / 1000)}s</span>
              {take.quality?.warnings?.length
                ? <em>{take.quality.warnings.length} issue{take.quality.warnings.length === 1 ? '' : 's'}</em>
                : <em className="ok">clean</em>}
              <button
                className="link"
                onClick={async () => {
                  await request(`/studio/take/${take.id}`, { method: 'DELETE' })
                  onSaved()
                }}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
