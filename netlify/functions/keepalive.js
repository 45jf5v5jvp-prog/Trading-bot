/*
 * Keep-alive: a tiny scheduled ping so the free-tier Supabase project never goes
 * idle long enough to be auto-paused. Netlify runs this on the schedule set in
 * netlify.toml ([functions."keepalive"]). It does one small write + read against
 * the same kv table the app uses — enough to count as activity. Uses the public
 * anon key (same value the app already ships); best-effort, never throws.
 */
const SB_URL = (process.env.SUPABASE_URL || 'https://tsahgjqyoghmprkmxjgb.supabase.co')
  .trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SB_KEY = (process.env.SUPABASE_ANON_KEY || 'sb_publishable_m6C3mI_4F_QsmKWuC_1Nkg_R2o4PrUB').trim();
const H = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` });

export const handler = async () => {
  const out = { at: new Date().toISOString() };
  try {
    // A write is the strongest "activity" signal — upsert a single heartbeat row.
    const w = await fetch(`${SB_URL}/rest/v1/kv?on_conflict=key`, {
      method: 'POST',
      headers: { ...H(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'ugb:keepalive', value: out.at, updated_at: out.at }),
    });
    out.write = w.status;
    // And a cheap read.
    const r = await fetch(`${SB_URL}/rest/v1/kv?select=key&limit=1`, { headers: H() });
    out.read = r.status;
  } catch (e) { out.error = String(e); }
  return { statusCode: 200, body: JSON.stringify(out) };
};
