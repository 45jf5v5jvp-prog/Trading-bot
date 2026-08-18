// Speech synthesis, behind one interface.
//
// The point of this file is that the rest of the app never knows which engine is
// talking. Today it can be a hosted API because that is the fastest way to hear
// whether the product works; the moment you have your own model running, you set
// VOICE_PROVIDER=local and point VOICE_LOCAL_URL at it, and nothing else in the
// codebase changes. That swap is the difference between renting a voice and
// owning one, and it should never require touching the product.

const PROVIDERS = {
  // Your own inference server. Anything that accepts JSON and returns audio
  // bytes works — most open-source TTS servers do out of the box, and if yours
  // wants a different field name, this is the only place it needs to change.
  async local(text) {
    const url = process.env.VOICE_LOCAL_URL
    if (!url) return { error: 'VOICE_LOCAL_URL is not set.' }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.VOICE_LOCAL_TOKEN ? { Authorization: `Bearer ${process.env.VOICE_LOCAL_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        text,
        voice: process.env.VOICE_LOCAL_VOICE ?? 'default',
        format: 'mp3',
      }),
    })
    if (!response.ok) return { error: `Voice server said ${response.status}: ${await response.text()}` }
    return { audio: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'audio/mpeg' }
  },

  async elevenlabs(text) {
    const key = process.env.ELEVENLABS_API_KEY
    const voice = process.env.ELEVENLABS_VOICE_ID
    if (!key || !voice) return { error: 'ElevenLabs is not configured.' }
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5', // lowest-latency model; the quality tiers add ~1s
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        }),
      },
    )
    if (!response.ok) return { error: `ElevenLabs said ${response.status}: ${await response.text()}` }
    return { audio: Buffer.from(await response.arrayBuffer()), contentType: 'audio/mpeg' }
  },
}

export function activeProvider() {
  const named = process.env.VOICE_PROVIDER
  if (named && PROVIDERS[named]) return named
  if (process.env.VOICE_LOCAL_URL) return 'local'
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) return 'elevenlabs'
  return null // the browser's built-in voice handles it
}

export async function speak(text) {
  const provider = activeProvider()
  if (!provider) return { error: 'No voice engine configured.' }
  try {
    return await PROVIDERS[provider](text)
  } catch (err) {
    return { error: err.message }
  }
}
