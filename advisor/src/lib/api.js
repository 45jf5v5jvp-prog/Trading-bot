const TOKEN_KEY = 'advisor.token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    clearToken()
    throw new Error('Session expired — sign in again.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export const api = {
  login: (passcode) => request('/login', { method: 'POST', body: { passcode } }),
  me: () => request('/me'),
  saveProfile: (profile) => request('/profile', { method: 'PUT', body: profile }),
  saveAccounts: (accounts) => request('/accounts', { method: 'PUT', body: { accounts } }),
  setAgendaCovered: (index, covered) =>
    request(`/agenda/${index}`, { method: 'PATCH', body: { covered } }),
  newConversation: () => request('/conversations', { method: 'POST' }),
  getConversation: (id) => request(`/conversations/${id}`),
  closeConversation: (id) => request(`/conversations/${id}/close`, { method: 'POST' }),
  setActionItem: (id, status) => request(`/action-items/${id}`, { method: 'PATCH', body: { status } }),
}

// Server-sent events over POST. EventSource can't POST, so we read the body
// stream ourselves.
export async function streamChat({ conversationId, message, onEvent, signal }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ conversationId, message }),
    signal,
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Chat failed.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (line) onEvent(JSON.parse(line.slice(6)))
    }
  }
}
