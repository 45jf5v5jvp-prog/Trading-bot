// Voice in and voice out.
//
// The latency trick that makes this feel live: don't wait for the full reply.
// Cut the token stream at sentence boundaries and start speaking sentence one
// while the model is still writing sentence three.

export function createSpeaker({ cloned, onStateChange = () => {} }) {
  let buffer = ''
  let chain = Promise.resolve()
  let stopped = false
  let pending = 0

  const setBusy = (delta) => {
    pending += delta
    onStateChange(pending > 0)
  }

  async function speakOne(sentence) {
    if (stopped || !sentence.trim()) return
    if (cloned) {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('advisor.token')}`,
          },
          body: JSON.stringify({ text: sentence }),
        })
        if (!res.ok) throw new Error('tts failed')
        const url = URL.createObjectURL(await res.blob())
        const audio = new Audio(url)
        await new Promise((resolve) => {
          audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); resolve() }
          audio.play().catch(resolve)
        })
        return
      } catch {
        // fall through to the browser voice rather than going silent
      }
    }
    await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(sentence)
      utterance.rate = 1.05
      utterance.onend = utterance.onerror = resolve
      speechSynthesis.speak(utterance)
    })
  }

  const enqueue = (sentence) => {
    setBusy(1)
    chain = chain.then(() => speakOne(sentence)).finally(() => setBusy(-1))
  }

  return {
    push(text) {
      buffer += text
      // Speak as soon as there's a complete sentence worth speaking. The length
      // floor stops "Mr." and "3.5%" from triggering a fragment.
      const match = buffer.match(/^([\s\S]{25,}?[.!?])\s/)
      if (match) {
        enqueue(match[1])
        buffer = buffer.slice(match[0].length)
      }
    },
    flush() {
      if (buffer.trim()) enqueue(buffer)
      buffer = ''
    },
    stop() {
      stopped = true
      buffer = ''
      speechSynthesis.cancel()
    },
  }
}

export const dictationSupported = () =>
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export function startDictation({ onText, onEnd }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  const recognition = new Recognition()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = 'en-US'

  let settled = ''
  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i]
      if (result.isFinal) settled += result[0].transcript
      else interim += result[0].transcript
    }
    onText((settled + interim).trim())
  }
  recognition.onend = () => onEnd?.(settled.trim())
  recognition.start()
  return () => recognition.stop()
}
