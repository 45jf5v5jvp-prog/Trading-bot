/*
 * Course lookup relay, running as a Netlify Function on the same site as the app.
 * Same-origin (no CORS), key stays server-side in a Netlify env var, and it
 * deploys straight from this repo — no Supabase SDK, no manual steps.
 *
 *   GET /.netlify/functions/courses?search_query=<name>  -> matching courses
 *   GET /.netlify/functions/courses?course_id=<id>       -> one full scorecard
 *
 * Two things keep it smooth under traffic and rate limits:
 *   1) A SHARED CACHE in the same Supabase the app already uses. Every good
 *      answer is remembered, so the *second* time anyone looks up a course it
 *      comes back instantly with no call to the golf API. More traffic => more
 *      cache hits => fewer API calls. Cache failures fall through silently to a
 *      live call, so the cache can never break a lookup.
 *   2) AUTO-RETRY with backoff. A brief "busy" (429) or server blip (5xx) is
 *      quietly retried a couple times before the app ever sees an error.
 *
 * Set the GolfCourseAPI key as a Netlify environment variable named GOLF_API_KEY.
 */
const API = 'https://api.golfcourseapi.com/v1';
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/* Supabase is optional. These are the same public values the app ships in
   index.html (anon/publishable key, protected by row-level security), so the
   cache needs zero extra setup. Env vars override if ever present. */
const SB_URL = (process.env.SUPABASE_URL || 'https://tsahgjqyoghmprkmxjgb.supabase.co')
  .trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SB_KEY = (process.env.SUPABASE_ANON_KEY || 'sb_publishable_m6C3mI_4F_QsmKWuC_1Nkg_R2o4PrUB').trim();
const SB_ON = !!(SB_URL && SB_KEY);

/* How long a cached answer stays fresh. Scorecards almost never change, so a
   full course card can live a long time; a search list is refreshed sooner in
   case a new course shows up. */
const TTL_COURSE = 30 * 24 * 60 * 60 * 1000; // 30 days
const TTL_SEARCH = 3 * 24 * 60 * 60 * 1000;  // 3 days

const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` });

async function cacheGet(key, ttl) {
  if (!SB_ON) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    const env = JSON.parse(rows[0].value);
    if (!env || !env.ts || (Date.now() - env.ts) > ttl) return null; // stale
    return env.body; // the raw JSON text the golf API returned
  } catch { return null; }
}

async function cacheSet(key, body) {
  if (!SB_ON) return;
  try {
    await fetch(`${SB_URL}/rest/v1/kv?on_conflict=key`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value: JSON.stringify({ ts: Date.now(), body }), updated_at: new Date().toISOString() }),
    });
  } catch { /* caching is best-effort; never break the lookup */ }
}

function timedFetch(target, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(target, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Fetch the golf API, quietly retrying a brief "busy" (429) or a server blip
   (5xx). Kept well under the function's time budget: 429s come back fast, and a
   true hang is only retried once. */
async function fetchWithRetry(target, key) {
  const opts = { headers: { Authorization: 'Key ' + key } };
  const backoff = [400, 1100]; // ms between attempts
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await timedFetch(target, opts, 6000);
      if (r.status === 429 || r.status >= 500) { // retryable
        last = { status: r.status, body: await r.text() };
        if (attempt < backoff.length) { await sleep(backoff[attempt]); continue; }
        return last;
      }
      return { status: r.status, body: await r.text() }; // 200s and 4xx (not 429) are final
    } catch (e) { // network error / timeout
      last = { status: 502, body: JSON.stringify({ error: String(e) }) };
      if (attempt === 0) { await sleep(backoff[0]); continue; } // retry a hang once
      return last;
    }
  }
  return last || { status: 502, body: JSON.stringify({ error: 'unreachable' }) };
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
  const cacheKey = id
    ? `apicache:course:${id}`
    : `apicache:search:${q.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const ttl = id ? TTL_COURSE : TTL_SEARCH;

  // 1) Serve from the shared cache when we can — no golf-API call at all.
  const cached = await cacheGet(cacheKey, ttl);
  if (cached != null) {
    return { statusCode: 200, headers: { ...HEADERS, 'X-Cache': 'HIT' }, body: cached };
  }

  // 2) Otherwise hit the golf API (with retries), and bank a good answer.
  const res = await fetchWithRetry(target, key);
  if (res.status === 200) cacheSet(cacheKey, res.body); // best-effort, don't await
  return { statusCode: res.status, headers: { ...HEADERS, 'X-Cache': 'MISS' }, body: res.body };
};
