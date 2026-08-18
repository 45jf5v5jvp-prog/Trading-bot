import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, setToken, clearToken, streamChat } from './lib/api.js'
import { createSpeaker } from './lib/voice.js'
import Login from './components/Login.jsx'
import Chat from './components/Chat.jsx'
import Rail from './components/Rail.jsx'
import LengthPicker from './components/LengthPicker.jsx'

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
  const [clock, setClock] = useState(null)
  const [choosingLength, setChoosingLength] = useState(false)
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

  async function startConversation(plannedMinutes) {
    const { conversation: conv } = await api.newConversation(plannedMinutes)
    setConversation(conv)
    setMessages([])
    setSources([])
    setNotice(null)
    setChoosingLength(false)
    setClock({ minutes: 0, planned: conv.plannedMinutes, checkpoint: null })
  }

  async function extend(minutes) {
    const { plannedMinutes } = await api.extendConversation(conversation.id, minutes)
    setClock((c) => ({ ...c, planned: plannedMinutes, checkpoint: null }))
    setNotice(`Meeting extended to ${plannedMinutes} minutes.`)
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
      setClock({ minutes: 0, planned: conv.plannedMinutes, checkpoint: null })
    }

    setDraft('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    let ranTool = false
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
              const last = next[next.length - 1]
              // A tool card can land mid-reply; the text after it starts a new bubble.
              if (!last || last.role !== 'assistant') {
                next.push({ role: 'assistant', content: event.text })
              } else {
                next[next.length - 1] = { ...last, content: last.content + event.text }
              }
              return next
            })
          } else if (event.type === 'tool') {
            ranTool = true
            setMessages((prev) => {
              const next = [...prev]
              // Drop the empty bubble the tool call interrupted.
              if (next.length && next[next.length - 1].role === 'assistant'
                && !next[next.length - 1].content) next.pop()
              next.push({ role: 'tool', name: event.name, result: event.result })
              return next
            })
          } else if (event.type === 'sources') {
            setSources(event.sources)
            setClock({
              minutes: event.minutes,
              planned: event.plannedMinutes,
              checkpoint: event.checkpoint,
            })
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
      // Tools write to the client record; pull the rail back into sync.
      if (ranTool) refresh()
    }
  }

  async function endReview() {
    if (!conversation) return
    setNotice('Saving what we discussed…')
    try {
      const result = await api.closeConversation(conversation.id)
      if (result.skipped) {
        setNotice(result.skipped)
      } else {
        setNotice(null)
        setMessages((prev) => [...prev, {
          role: 'recap',
          recap: result.recap,
          summary: result.summary,
          title: conversation.title,
        }])
      }
      await refresh()
      setConversation(null)
      setClock(null)
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
          {clock && (
            <span className={`clock ${clock.checkpoint ?? ''}`}>
              {clock.minutes} / {clock.planned} min
            </span>
          )}
          {clock && (clock.checkpoint === 'wrap' || clock.checkpoint === 'overtime') && (
            <button className="ghost" onClick={() => extend(15)}>+15 min</button>
          )}
          <button className="ghost" onClick={() => setChoosingLength(true)}>New review</button>
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

      {choosingLength && (
        <LengthPicker onPick={startConversation} onCancel={() => setChoosingLength(false)} />
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
        <Rail me={me} onOpenConversation={openConversation} onRefresh={refresh} />
      </main>
    </div>
  )
}
