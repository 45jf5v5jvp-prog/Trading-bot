import React, { useEffect, useRef, useState } from 'react'
import { dictationSupported, startDictation } from '../lib/voice.js'

export default function Chat({ messages, draft, setDraft, onSend, streaming, sources }) {
  const scroller = useRef(null)
  const stopDictation = useRef(null)
  const [listening, setListening] = useState(false)
  const [showSources, setShowSources] = useState(false)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  function toggleMic() {
    if (listening) {
      stopDictation.current?.()
      return
    }
    setListening(true)
    stopDictation.current = startDictation({
      onText: setDraft,
      onEnd: () => setListening(false),
    })
  }

  function keyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <section className="chat">
      <div className="messages" ref={scroller}>
        {!messages.length && (
          <div className="empty">
            <h2>What's on your mind?</h2>
            <p>
              Ask the way a client would ask. The answers come from your recorded voice, and
              everything you cover gets remembered for next time.
            </p>
          </div>
        )}

        {messages.map((message, i) => (
          <div key={i} className={`msg ${message.role}`}>
            {message.content
              ? message.content.split('\n\n').map((para, j) => <p key={j}>{para}</p>)
              : <span className="typing"><i /><i /><i /></span>}
          </div>
        ))}
      </div>

      {sources.length > 0 && (
        <div className="sources">
          <button className="link" onClick={() => setShowSources((v) => !v)}>
            {showSources ? 'Hide' : 'Show'} the {sources.length} recorded answers this drew on
          </button>
          {showSources && (
            <ul>
              {sources.map((s, i) => (
                <li key={i}><span className="score">{s.score}</span> {s.question}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={keyDown}
          placeholder={listening ? 'Listening…' : 'Ask a question'}
          rows={2}
        />
        {dictationSupported() && (
          <button className={`mic ${listening ? 'on' : ''}`} onClick={toggleMic} title="Talk instead of typing">
            ●
          </button>
        )}
        <button className="primary" onClick={onSend} disabled={streaming || !draft.trim()}>
          {streaming ? 'Thinking…' : 'Send'}
        </button>
      </div>
    </section>
  )
}
