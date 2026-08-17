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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const q = (url.searchParams.get("search_query") || url.searchParams.get("q") || "").trim();
  if (!q) return json({ courses: [] });

  const key = Deno.env.get("GOLF_API_KEY");
  if (!key) return json({ error: "GOLF_API_KEY secret is not set" }, 500);

  try {
    const r = await fetch(
      "https://api.golfcourseapi.com/v1/search?search_query=" + encodeURIComponent(q),
      { headers: { Authorization: "Key " + key } },
    );
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
});
