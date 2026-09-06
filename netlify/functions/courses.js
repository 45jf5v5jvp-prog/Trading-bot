/*
 * Course lookup relay, running as a Netlify Function on the same site as the app.
 * Same-origin (no CORS), key stays server-side in a Netlify env var, and it
 * deploys straight from this repo — no Supabase, no manual steps.
 *
 *   GET /.netlify/functions/courses?search_query=<name>  -> matching courses
 *   GET /.netlify/functions/courses?course_id=<id>       -> one full scorecard
 *
 * Set the GolfCourseAPI key as a Netlify environment variable named GOLF_API_KEY.
 */
const API = 'https://api.golfcourseapi.com/v1';
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

async function timedFetch(target, auth, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(target, { ...auth, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: 'ok' };
  const key = process.env.GOLF_API_KEY;
  if (!key) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'GOLF_API_KEY env var is not set' }) };

  const p = event.queryStringParameters || {};
  const id = (p.course_id || '').trim();
  const q = (p.search_query || p.q || '').trim();
  if (!id && !q) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ courses: [] }) };

  const target = id
    ? `${API}/courses/${encodeURIComponent(id)}`
    : `${API}/search?search_query=${encodeURIComponent(q)}`;
  try {
    const r = await timedFetch(target, { headers: { Authorization: 'Key ' + key } });
    const body = await r.text();
    return { statusCode: r.status, headers: HEADERS, body };
  } catch (e) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: String(e) }) };
  }
};
