import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, setToken, clearToken, streamChat } from './lib/api.js'
import { createSpeaker } from './lib/voice.js'
import Login from './components/Login.jsx'
import Chat from './components/Chat.jsx'
import Memory from './components/Memory.jsx'

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()))
  const [me, setMe] = useState(null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sources, setSources] = useState([])
  const [speakReplies, setSpeakReplies] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [notice, setNotice] = useState(null)
  const [error, setError] = useState(null)
  const speakerRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me())
    } catch (err) {
      setError(err.message)
      if (err.message.includes('sign in')) setAuthed(false)
    }
  }, [])

  useEffect(() => { if (authed) refresh() }, [authed, refresh])

  async function startConversation() {
    const { conversation: conv } = await api.newConversation()
    setConversation(conv)
    setMessages([])
    setSources([])
    setNotice(null)
  }

  async function openConversation(id) {
    const { conversation: conv } = await api.getConversation(id)
    setConversation(conv)
    setMessages(conv.messages)
    setSources([])
  }

  async function send() {
    const text = draft.trim()
    if (!text || streaming) return
    let conv = conversation
    if (!conv) {
      const created = await api.newConversation()
      conv = created.conversation
      setConversation(conv)
    }

    setDraft('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setStreaming(true)

    const speaker = speakReplies
      ? createSpeaker({ cloned: me?.voice?.cloned, onStateChange: setSpeaking })
      : null
    speakerRef.current = speaker

    try {
      await streamChat({
        conversationId: conv.id,
        message: text,
        onEvent: (event) => {
          if (event.type === 'text') {
            speaker?.push(event.text)
            setMessages((prev) => {
              const next = [...prev]
              next[next.length - 1] = {
                ...next[next.length - 1],
                content: next[next.length - 1].content + event.text,
              }
              return next
            })
          } else if (event.type === 'sources') {
            setSources(event.sources)
          } else if (event.type === 'error') {
            setError(event.error)
          }
        },
      })
      speaker?.flush()
    } catch (err) {
      setError(err.message)
    } finally {
      setStreaming(false)
    }
  }

  async function endReview() {
    if (!conversation) return
    setNotice('Saving what we discussed…')
    try {
      const result = await api.closeConversation(conversation.id)
      setNotice(result.skipped ? result.skipped : `Saved: ${result.summary}`)
      await refresh()
      setConversation(null)
      setMessages([])
    } catch (err) {
      setNotice(null)
      setError(err.message)
    }
  }

  function stopSpeaking() {
    speakerRef.current?.stop()
    setSpeaking(false)
  }

  function signOut() {
    clearToken()
    setAuthed(false)
    setMe(null)
    setConversation(null)
    setMessages([])
  }

  if (!authed) {
    return <Login onSuccess={(token) => { setToken(token); setAuthed(true) }} />
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <div>
            <strong>Your review</strong>
            <span className="sub">
              {me ? `${me.persona.recordedAnswers} recorded answers loaded` : 'loading…'}
            </span>
          </div>
        </div>
        <div className="controls">
          <label className={`toggle ${speakReplies ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={speakReplies}
              onChange={(e) => { setSpeakReplies(e.target.checked); if (!e.target.checked) stopSpeaking() }}
            />
            {me?.voice?.cloned ? 'Cloned voice' : 'Speak replies'}
          </label>
          {speaking && <button className="ghost" onClick={stopSpeaking}>Stop</button>}
          <button className="ghost" onClick={startConversation}>New review</button>
          {conversation && messages.length > 1 && (
            <button className="primary" onClick={endReview}>End &amp; remember</button>
          )}
          <button className="ghost quiet" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {(notice || error) && (
        <div className={`banner ${error ? 'bad' : ''}`} onClick={() => { setNotice(null); setError(null) }}>
          {error || notice}
        </div>
      )}

      <main className="layout">
        <Chat
          messages={messages}
          draft={draft}
          setDraft={setDraft}
          onSend={send}
          streaming={streaming}
          sources={sources}
        />
        <Memory me={me} onOpenConversation={openConversation} onRefresh={refresh} />
      </main>
    </div>
  )
}
