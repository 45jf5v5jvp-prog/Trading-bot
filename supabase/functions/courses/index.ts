// Golf Bets Tracker — course search relay (Supabase Edge Function)
//
// Holds the GolfCourseAPI key server-side (so it never ships to the phone) and
// adds CORS so the app can call it from the browser. The app hits:
//   GET  <project>.supabase.co/functions/v1/courses?search_query=<name>
// and this forwards to GolfCourseAPI and returns its JSON unchanged.
//
// SETUP (all in the Supabase dashboard, no command line):
//   1. Edge Functions -> Deploy a new function -> name it exactly "courses"
//      -> paste this whole file -> Deploy.
//   2. Turn OFF "Verify JWT" for this function (so the app can call it without
//      a login token).
//   3. Edge Functions -> Secrets (or Project Settings -> Edge Functions) ->
//      add a secret named GOLF_API_KEY with your GolfCourseAPI key.
//   4. In the app's config, set GOLF_PROXY to this function's URL.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const API = "https://api.golfcourseapi.com/v1";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const key = Deno.env.get("GOLF_API_KEY");
  if (!key) return json({ error: "GOLF_API_KEY secret is not set" }, 500);
  const auth = { headers: { Authorization: "Key " + key } };

  const id = (url.searchParams.get("course_id") || "").trim();
  const q = (url.searchParams.get("search_query") || url.searchParams.get("q") || "").trim();

  try {
    // One course's full scorecard by id (efficient path for newer app builds).
    if (id) {
      const r = await fetch(`${API}/courses/${encodeURIComponent(id)}`, auth);
      return new Response(await r.text(), { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (!q) return json({ courses: [] });

    // Search returns only a summary (tee counts, no holes). Fill in each match's
    // real scorecard so the app gets full tees straight from the search — this is
    // what makes any course load without a second round trip from older builds.
    const r = await fetch(`${API}/search?search_query=${encodeURIComponent(q)}`, auth);
    if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
    const data = await r.json();
    const list = Array.isArray(data.courses) ? data.courses.slice(0, 10) : [];
    const full = await Promise.all(list.map(async (c: any) => {
      try {
        const dr = await fetch(`${API}/courses/${encodeURIComponent(c.id)}`, auth);
        if (!dr.ok) return c;
        const dd = await dr.json();
        const detail = dd.course || dd;
        return { ...c, tees: detail.tees || c.tees };
      } catch {
        return c;
      }
    }));
    return json({ courses: full });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
});
