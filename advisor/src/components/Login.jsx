import React, { useState } from 'react'
import { api } from '../lib/api.js'

export default function Login({ onSuccess }) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { token } = await api.login(passcode)
      onSuccess(token)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Sit down for a minute</h1>
        <p>Private prototype. Nothing here is live and no one else can see it.</p>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          autoFocus
        />
        <button className="primary" disabled={busy || !passcode}>
          {busy ? 'Checking…' : 'Come in'}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  )
}
