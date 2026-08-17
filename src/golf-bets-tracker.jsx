import React, { useState, useEffect, useMemo, useRef } from 'react';

/* ==========================================================================
   ULTIMATE GOLF BETTING
   Scorecard first. Stack as many games as you want on top of it.
   ========================================================================== */

const APP_NAME = 'GOLF BETS';
const APP_SUB = 'TRACKER';

/* Two palettes. Day is the default: a golf app is a friendly, social thing and
   a bright card reads that way. Night stays around because a phone at 9% on the
   back nine in fading light is a real situation.
   'ink' is the accent used as text, 'onBall' and 'onTone' are what sits on top
   of a filled button. */
const THEMES = {
  day: {
    felt: '#F1F5EC', card: '#FFFFFF', card2: '#FCF3DB', line: '#D6DFCE',
    chalk: '#17291F', muted: '#576E60', ball: '#F2C230', ink: '#8A6707',
    up: '#15774A', down: '#C0372B', snake: '#7A3FBF',
    onBall: '#241B03', onTone: '#FFFFFF',
  },
  night: {
    felt: '#0C1B14', card: '#132719', card2: '#1A3423', line: '#25452F',
    chalk: '#E9F0E7', muted: '#7C9A86', ball: '#F5C63D', ink: '#F5C63D',
    up: '#4FD48A', down: '#FF6E5B', snake: '#C77DFF',
    onBall: '#0C1B14', onTone: '#0C1B14',
  },
};
const C = { ...THEMES.day };

/* Style objects built at module load get re-poured when the palette flips. */
function applyTheme(name) {
  Object.assign(C, THEMES[name] || THEMES.day);
  Object.assign(inputStyle, { background: C.card, border: `1px solid ${C.line}`, color: C.chalk });
  Object.assign(stepBtn, { border: `1px solid ${C.line}`, color: C.chalk });
  Object.assign(navBtn, { border: `1px solid ${C.line}`, color: C.chalk });
  Object.assign(panel, { background: C.card });
}
const F_DISP = "'Archivo', 'Helvetica Neue', system-ui, sans-serif";
const F_MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

const DEF_PAR = [4,4,3,5,4,4,3,4,5, 4,5,3,4,4,4,3,5,4];
const DEF_SI  = [7,3,15,11,1,9,17,5,13, 8,4,16,12,2,10,18,6,14];
const DEF_YDS = [400,415,170,535,395,410,155,385,520, 405,540,175,390,420,400,165,525,410];
const defYards = (par) => (par === 3 ? 165 : par === 5 ? 530 : 400);

const oddSplit = (n) => Array.from({ length: n }, (_, i) => 2 * n - 1 - 2 * i);
const pointsLabel = (n) => (n === 3 ? '9 Point (Nines)' : `${2 * n - 1} Point`);

/* ==========================================================================
   STORAGE
   Two scopes, one interface (mirrors the shape the app was written against):
     - device-local keys (the in-progress round, trip, theme) live in
       localStorage, so they survive closing the browser on THIS phone.
     - shared keys (a published round/trip under a group code) live in a
       Supabase table so every phone in the group can read the same board.

   Sharing is optional. Fill in window.SIDE_ACTION_CONFIG (see index.html) with
   a Supabase URL + anon key to turn it on. Leave it blank and the app runs
   solo: one phone keeps the card, everything saved on that device.
   ========================================================================== */

const _CFG = (typeof window !== 'undefined' && window.SIDE_ACTION_CONFIG) || {};
/* Accept the URL however it was pasted: with or without a trailing slash, and
   with or without the /rest/v1 suffix Supabase shows on its "Data API" page. */
const SUPABASE_URL = (_CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SUPABASE_ANON_KEY = _CFG.SUPABASE_ANON_KEY || '';
const SHARING_ON = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

/* A tiny key/value client over Supabase's REST (PostgREST) endpoint. No SDK,
   so nothing to bundle. Table: kv(key text primary key, value text,
   updated_at timestamptz). get() throws when a key is missing — the code-
   picker relies on that to tell a free code from a taken one. */
const _kvHeaders = () => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
});
const _kvUrl = (key) => `${SUPABASE_URL}/rest/v1/kv?key=eq.${encodeURIComponent(key)}`;

const remote = {
  async get(key) {
    if (!SHARING_ON) throw new Error('sharing off');
    const res = await fetch(`${_kvUrl(key)}&select=value`, { headers: _kvHeaders() });
    if (!res.ok) throw new Error(`kv get ${res.status}`);
    const rows = await res.json();
    if (!rows.length) throw new Error('missing');
    return { value: rows[0].value };
  },
  async set(key, value) {
    if (!SHARING_ON) return;
    /* on_conflict=key makes the upsert explicit against real Supabase/PostgREST. */
    const res = await fetch(`${SUPABASE_URL}/rest/v1/kv?on_conflict=key`, {
      method: 'POST',
      headers: { ..._kvHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`kv set ${res.status}`);
  },
  async delete(key) {
    if (!SHARING_ON) return;
    await fetch(_kvUrl(key), { method: 'DELETE', headers: _kvHeaders() });
  },
  /* A cheap reachability check for the setup indicator on the home screen.
     Distinguishes "not set up" from "wrong key / RLS" from "wrong URL / offline"
     so a misconfiguration surfaces before the first tee, not during the round. */
  async ping() {
    if (!SHARING_ON) return { ok: false, reason: 'off' };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/kv?select=key&limit=1`, { headers: _kvHeaders() });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
      if (res.status === 404) return { ok: false, reason: 'table' };
      return { ok: false, reason: 'http', status: res.status };
    } catch { return { ok: false, reason: 'network' }; }
  },
};

/* The interface the rest of the app calls. `shared` picks the scope:
   false/undefined -> this device (localStorage); true -> the group (Supabase). */
const storage = {
  async get(key, shared) {
    if (shared) return remote.get(key);
    const value = localStorage.getItem(key);
    return value == null ? null : { value };
  },
  async set(key, value, shared) {
    if (shared) return remote.set(key, value);
    try { localStorage.setItem(key, value); } catch {}
  },
  async delete(key, shared) {
    if (shared) return remote.delete(key);
    try { localStorage.removeItem(key); } catch {}
  },
};

/* ==========================================================================
   GAMES
   ========================================================================== */

const GAMES = {
  skins: {
    name: () => 'Skins', unit: 'per skin', teams: false, defStake: 5,
    ok: (n) => n >= 2,
    blurb: () => 'Low score takes the hole. Ties carry over and the pot swells.',
  },
  nassau: {
    name: () => 'Nassau', unit: 'per match', teams: 'optional', defStake: 5,
    ok: (n) => n === 2 || n === 4,
    blurb: () => 'Three bets in one: front, back, and the eighteen. Press when you are down.',
  },
  roundrobin: {
    name: () => 'Nassau Sixes', unit: 'per match', teams: false, defStake: 2,
    ok: (n) => n === 4,
    blurb: () => 'Partners switch every six holes. Inside each stretch you play a whole Nassau in miniature: the first three holes are the front, the next three are the back, and all six together are the overall. Three stretches, so everybody partners with everybody once.',
  },
  wolf: {
    name: () => 'Wolf', unit: 'per point', teams: false, defStake: 1,
    ok: (n) => n >= 3 && n <= 5,
    blurb: () => 'Rotating captain picks a partner off the tee, or goes alone for double.',
  },
  vegas: {
    name: () => 'Vegas', unit: 'per point', teams: true, defStake: 0.25,
    ok: (n) => n >= 4 && n <= 16,
    blurb: (n) => {
      const t = Math.floor(n / 2) + (n % 2);
      return n > 4
        ? `${t} teams. Scores mash into a two digit number and every team plays every other team, so that is ${t * (t - 1) / 2} matchups a hole.${n % 2 ? ' Odd man out draws a blind partner.' : ''}`
        : 'Two on two. Scores mash into a two digit number. Birdies flip the other side.';
    },
  },
  hammer: {
    name: () => 'Hammer', unit: 'base bet', teams: 'optional', defStake: 2,
    ok: (n) => n === 2 || n === 4,
    blurb: () => 'The bet doubles every time somebody throws the hammer. Accept or concede.',
  },
  points: {
    name: (n) => pointsLabel(n), unit: 'per point', teams: false, defStake: 0.25,
    ok: (n) => n >= 3 && n <= 16,
    blurb: (n) => `Low score takes ${2 * n - 1}, then ${2 * n - 3}, on down to 1. Ties split the slots.`,
  },
  yardage: {
    name: () => 'Yardage', unit: 'per yard', teams: false, defStake: 0.1,
    ok: (n) => n >= 2,
    blurb: () => 'Every hole is worth its length. Low score takes it. A 400 yard hole at a dime a yard is $40.',
  },
  stableford: {
    name: () => 'Stableford', unit: 'per point', teams: false, defStake: 1,
    ok: (n) => n >= 2,
    blurb: () => 'Points against par. Bogey 1, par 2, birdie 3, eagle 4. Blow-ups just score zero.',
  },
  bbb: {
    name: () => 'Bingo Bango Bongo', unit: 'per point', teams: false, defStake: 1,
    ok: (n) => n >= 2 && n <= 6,
    blurb: () => 'Three points a hole: first on the green, closest once all are on, first in the cup.',
  },
};
const gameName = (k, n) => GAMES[k].name(n);
const isPointGame = (k) => GAMES[k].unit === 'per point';
/* Games where you have a partner you can swap. Nassau is excluded: a match
   needs the same two sides from the first tee to the last putt. */
const PARTNER_GAMES = ['vegas', 'hammer'];

/* ==========================================================================
   JUNK
   ========================================================================== */

const JUNK = {
  birdie:   { name: 'Birdie Machine', sign: 1, auto: true,
    info: 'Every birdie pays. Each other player hands you the amount. An eagle pays double, an albatross triple. Scored automatically off the card, nothing to tap.' },
  greenie:  { name: 'Greenie', sign: 1, par3: true, one: true,
    info: 'Closest to the pin in regulation on a par 3. Most groups make you two-putt or better to keep it.' },
  polie:    { name: 'Polie', sign: 1,
    info: 'Make a putt longer than the flagstick, roughly seven feet or more. Some groups lay the pin down to measure.' },
  barkie:   { name: 'Barkie', sign: 1,
    info: 'Hit a tree anywhere on the hole and still walk off with par.' },
  sandie:   { name: 'Sandie', sign: 1,
    info: 'Up and down out of a bunker for par or better.' },
  hazzie:   { name: 'Hazzie', sign: 1,
    info: 'Find a penalty area and still save par.' },
  arnie:    { name: 'Arnie', sign: 1,
    info: 'Make par without ever touching the fairway. Named for Arnold Palmer, who did it constantly.' },
  chippie:  { name: 'Chippie', sign: 1,
    info: 'Hole out with a chip or pitch from off the green.' },
  ferret:   { name: 'Golden Ferret', sign: 1,
    info: 'Hole out straight from a bunker. Rare enough that most groups pay it double.' },
  oozle:    { name: 'Oozle', sign: 1,
    info: 'First birdie of the round. One payout for the day, not per hole.' },
  fish:     { name: 'Fish', sign: -1,
    info: 'Put one in the water. You pay everybody.' },
  threeputt:{ name: 'Three Putt', sign: -1,
    info: 'Every three putt pays out on the spot. Use this instead of Snake if you want each one to hurt right away.' },
  snake:    { name: 'Snake', sign: -1, hold: true,
    info: 'Three putt and you take the snake. It passes to the next man who three putts, and it grows every time it moves. Whoever is holding it walking off eighteen pays the whole group.' },
};

/* ==========================================================================
   HELPERS
   ========================================================================== */

const uid = () => Math.random().toString(36).slice(2, 9);
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(Math.abs(n) % 1 ? 2 : 0);
const zero = (r) => Object.fromEntries(r.players.map(p => [p.id, 0]));
const nameOf = (r, id) => (r.players.find(p => p.id === id) || {}).name || '?';
const addInto = (t, m) => { for (const k in m) t[k] = (t[k] || 0) + (m[k] || 0); };
const short = (s) => (s || '').slice(0, 7);
const fmtP = (v) => (v % 1 ? v.toFixed(1) : String(v));
const r2 = (x) => Math.round(x * 100) / 100;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function strokesFor(round, pid, h) {
  if (!round.useNet) return 0;
  const low = Math.min(...round.players.map(p => Number(p.hcp) || 0));
  const rel = Math.max(0, Math.round((Number(round.players.find(p => p.id === pid)?.hcp) || 0) - low));
  const si = round.si[h];
  return Math.floor(rel / 18) + (si <= (rel % 18) ? 1 : 0);
}
const gross = (r, pid, h) => (r.scores?.[h]?.[pid] ?? null);
const net = (r, pid, h) => { const g = gross(r, pid, h); return g == null ? null : g - strokesFor(r, pid, h); };
const holeComplete = (r, h) => r.players.every(p => gross(r, p.id, h) != null);
function playedHoles(r) { const o = []; for (let h = 0; h < r.holes; h++) if (holeComplete(r, h)) o.push(h); return o; }
const sidesOf = (r) => (r.teams?.length === 2 ? r.teams : [[r.players[0].id], [r.players[1].id]]);
function sideNet(r, side, h) { const v = side.map(id => net(r, id, h)).filter(x => x != null); return v.length ? Math.min(...v) : null; }

/* Partners can be locked for the day or reset every hole. Nassau is the one
   exception: a match needs the same two sides start to finish. */
const teamsAt = (r, h) => (r.partnerMode === 'rotate' && r.holeTeams?.[h]) || r.teams;

/* Round robin: new pairing every six holes, three pairings covers eighteen. */
/* Stable pseudo random so every phone in the group draws the same partner. */
const hashStr = (str) => { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return Math.abs(x); };

/* Odd field: the man without a partner draws one out of the hat each hole.
   His drawn partner still plays for his own team too. */
function blindPartner(round, h) {
  const solo = (round.teams || []).find(t => t.length === 1);
  if (!solo || !round.blindDraw) return null;
  const pool = round.players.map(p => p.id).filter(id => id !== solo[0]);
  if (!pool.length) return null;
  return pool[hashStr(`${round.code || 'seed'}:${h}`) % pool.length];
}
function vegasTeamsAt(round, h) {
  const base = (round.teams || []).filter(t => t.length === 2);
  const drawn = blindPartner(round, h);
  if (!drawn) return base;
  const solo = round.teams.find(t => t.length === 1);
  return [...base, [solo[0], drawn]];
}

const RR_SEG = 6;
const rrSegOf = (h) => Math.floor(h / RR_SEG);
function rrTeams(round, seg) {
  const ids = round.players.map(p => p.id), pr = PAIRINGS[seg % 3];
  return [pr[0].map(i => ids[i]), pr[1].map(i => ids[i])];
}

const PAIRINGS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
const pairingIndex = (round, teams) => {
  if (!teams) return -1;
  const ids = round.players.map(p => p.id);
  return PAIRINGS.findIndex(pr =>
    pr.some(t => t.map(i => ids[i]).sort().join() === [...teams[0]].sort().join())
  );
};

/* Everybody settles with everybody. You pay each other player the point
   difference between you, which is the same as (n x your points - the field). */
function settle(round, pts, stake) {
  const n = round.players.length;
  const total = round.players.reduce((s, p) => s + (pts[p.id] || 0), 0);
  const m = {};
  round.players.forEach(p => { m[p.id] = stake * (n * (pts[p.id] || 0) - total); });
  return m;
}

function allocate(rows, split) {
  const m = {}; let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].n === rows[i].n) j++;
    const share = split.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1);
    for (let k = i; k <= j; k++) m[rows[k].id] = share;
    i = j + 1;
  }
  return m;
}

/* ==========================================================================
   SETTLEMENT
   ========================================================================== */

function directTransfers(map, players) {
  const cred = [], deb = [];
  players.forEach(p => {
    const v = r2(map[p.id] || 0);
    if (v > 0.004) cred.push({ id: p.id, v });
    else if (v < -0.004) deb.push({ id: p.id, v: -v });
  });
  cred.sort((a, b) => b.v - a.v); deb.sort((a, b) => b.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < deb.length && j < cred.length) {
    const amt = r2(Math.min(deb[i].v, cred[j].v));
    if (amt > 0.004) out.push({ from: deb[i].id, to: cred[j].id, amt });
    deb[i].v = r2(deb[i].v - amt); cred[j].v = r2(cred[j].v - amt);
    if (deb[i].v <= 0.004) i++;
    if (cred[j].v <= 0.004) j++;
  }
  return out;
}

function bankerTransfers(map, players, bankerId) {
  const out = [];
  players.forEach(p => {
    if (p.id === bankerId) return;
    const v = r2(map[p.id] || 0);
    if (v < -0.004) out.push({ from: p.id, to: bankerId, amt: -v });
    else if (v > 0.004) out.push({ from: bankerId, to: p.id, amt: v });
  });
  return out.sort((a, b) => b.amt - a.amt);
}

/* ==========================================================================
   COURSE LOOKUP

   Two sources, tried in order:
     1. GolfCourseAPI — a full database that returns every tee with per-hole
        par, handicap index, and yardage. This is what makes "pick any course,
        pick any tees, it all fills in" work. It needs a key, which must live
        on a server, not in the page — so the app calls a relay (GOLF_PROXY)
        that holds the key. (GOLF_API_KEY calls it directly; only for testing,
        since a browser key is exposed and usually blocked by CORS.)
     2. OpenGolfAPI — free and keyless, used when no relay is set up. Patchy
        coverage and a single tee, but better than nothing.
   Built-in courses (baked into the app) and the manual editor always work.
   ========================================================================== */

const GOLF_PROXY = (_CFG.GOLF_PROXY || '').trim().replace(/\/+$/, '');
const GOLF_API_KEY = (_CFG.GOLF_API_KEY || '').trim();
const COURSE_DB_ON = !!(GOLF_PROXY || GOLF_API_KEY);

/* Flatten a GolfCourseAPI course into { id, name, city, state, tees:[...] },
   each tee { label, total, par[], hcp[], yards[] }. */
function normalizeDbCourse(c) {
  const tees = [];
  const addSet = (arr, tag) => (arr || []).forEach(t => {
    const holes = t.holes || [];
    if (holes.length < 9) return;
    tees.push({
      label: `${t.tee_name || 'Tee'}${tag ? ` ${tag}` : ''}`,
      total: Number(t.total_yards) || holes.reduce((a, h) => a + (Number(h.yardage) || 0), 0),
      par: holes.map(h => Number(h.par) || null),
      hcp: holes.map(h => Number(h.handicap) || null),
      yards: holes.map(h => Number(h.yardage) || null),
    });
  });
  addSet(c.tees?.male, ''); addSet(c.tees?.female, 'W');
  return {
    id: c.id, name: c.course_name || c.club_name || 'Course',
    city: c.location?.city, state: c.location?.state, tees,
  };
}

/* Search the full database (via the relay, or directly if only a key is set). */
async function searchCourseDb(q) {
  let res;
  if (GOLF_PROXY) {
    res = await fetch(`${GOLF_PROXY}?search_query=${encodeURIComponent(q)}`);
  } else {
    res = await fetch(`https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Key ${GOLF_API_KEY}` } });
  }
  if (!res.ok) throw new Error(`db ${res.status}`);
  const d = await res.json();
  return (d.courses || []).map(normalizeDbCourse).filter(c => c.tees.length);
}

/* --- OpenGolfAPI (keyless fallback) --- */
const OG = 'https://api.opengolfapi.org/api/v1';

async function searchCourses({ q, lat, lng, radius = 30 }) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (lat != null) { p.set('lat', String(lat)); p.set('lng', String(lng)); p.set('radius_mi', String(radius)); }
  const res = await fetch(`${OG}/courses/search?${p.toString()}`);
  if (!res.ok) throw new Error(`Course search returned ${res.status}`);
  const d = await res.json();
  return (d.courses || []).filter(c => (c.holes || 18) >= 9);
}

async function loadCourse(id) {
  const res = await fetch(`${OG}/courses/${id}`);
  if (!res.ok) throw new Error(`Course load returned ${res.status}`);
  const d = await res.json();
  const raw = d.holes || d.course?.holes || d.scorecard?.holes || d.tees?.[0]?.holes || [];
  return {
    name: d.course_name || d.name || 'Course',
    holes: raw.map(h => ({
      par: Number(h.par ?? h.hole_par) || null,
      si: Number(h.handicap ?? h.handicap_index ?? h.stroke_index ?? h.index ?? h.si) || null,
      yds: Number(h.yards ?? h.yardage ?? h.length ?? h.distance ?? h.tees?.[0]?.yards) || null,
    })),
  };
}

/* ==========================================================================
   ENGINES — each takes (round, stake)
   ========================================================================== */

function calcSkins(round, stake) {
  const total = zero(round), log = []; let carry = 1;
  for (const h of playedHoles(round)) {
    const nets = round.players.map(p => ({ id: p.id, n: net(round, p.id, h) }));
    const low = Math.min(...nets.map(x => x.n));
    const w = nets.filter(x => x.n === low);
    if (w.length === 1) {
      const val = stake * carry, m = zero(round);
      round.players.forEach(p => { m[p.id] = p.id === w[0].id ? val * (round.players.length - 1) : -val; });
      addInto(total, m);
      log.push({ h, text: `${nameOf(round, w[0].id)} takes ${carry} skin${carry > 1 ? 's' : ''}`, m });
      carry = 1;
    } else {
      const carries = round.skinsCarry !== false;
      log.push({ h, text: carries ? `Halved. ${carry + 1} riding on the next hole` : `Halved. ${money(stake)} washes`, m: zero(round) });
      if (carries) carry++;
    }
  }
  return { money: total, points: null, log, extra: carry > 1 ? `${carry} skins riding` : null };
}

function diffFor(round, A, B, s, e) {
  let d = 0;
  for (const h of playedHoles(round)) {
    if (h < s || h > e) continue;
    const a = sideNet(round, A, h), b = sideNet(round, B, h);
    if (a == null || b == null) continue;
    if (a < b) d++; else if (b < a) d--;
  }
  return d;
}
const matchDiff = (round, s, e) => { const [A, B] = sidesOf(round); return diffFor(round, A, B, s, e); };
const pressesFor = (round, game) => (round.presses || []).filter(p => (p.game || 'nassau') === game);

/* Settle one head to head match and write the line. */
function runMatch(round, A, B, mt, total, log, tag) {
  const e = Math.min(mt.e, round.holes - 1);
  if (mt.s > e) return;
  const st = mt.stake;
  const d = diffFor(round, A, B, mt.s, e);
  const done = playedHoles(round).filter(h => h >= mt.s && h <= e).length === (e - mt.s + 1);
  const side = (s) => s.map(id => nameOf(round, id)).join(' + ');
  const status = d === 0 ? 'all square' : `${side(d > 0 ? A : B)} ${Math.abs(d)} up`;
  const head = `${tag ? tag + ' ' : ''}${mt.label}`;
  if (d !== 0 && done) {
    const win = d > 0 ? A : B, lose = d > 0 ? B : A, m = zero(round);
    win.forEach(id => m[id] = st / win.length);
    lose.forEach(id => m[id] = -st / lose.length);
    addInto(total, m);
    log.push({ h: e, text: `${head}: ${status}, ${money(st)}`, m });
  } else {
    log.push({ h: mt.s, text: `${head}: ${status}${done ? '' : ` (${money(st)} live)`}`, m: zero(round), live: !done });
  }
}

function calcNassau(round, stake) {
  const [A, B] = sidesOf(round), total = zero(round), log = [];
  const matches = [
    { label: 'Front', s: 0, e: 8, stake },
    { label: 'Back', s: 9, e: 17, stake },
    { label: 'Overall', s: 0, e: 17, stake },
    ...pressesFor(round, 'nassau').map((p, i) => ({ label: `Press ${i + 1} from ${p.s + 1}`, s: p.s, e: p.e, stake: p.stake ?? stake })),
  ].filter(m => m.s < round.holes);
  matches.forEach(mt => runMatch(round, A, B, mt, total, log));
  return { money: total, points: null, log };
}

function calcRoundRobin(round, stake) {
  const total = zero(round), log = [];
  const segs = Math.ceil(round.holes / RR_SEG);
  for (let s = 0; s < segs; s++) {
    const start = s * RR_SEG, end = Math.min(start + RR_SEG - 1, round.holes - 1);
    if (end < start) continue;
    const [A, B] = rrTeams(round, s);
    const half = Math.floor((end - start + 1) / 2);
    const mid = start + half - 1;
    const matches = [
      ...(half > 0 ? [{ label: `${start + 1}-${mid + 1}`, s: start, e: mid, stake }] : []),
      ...(mid + 1 <= end ? [{ label: `${mid + 2}-${end + 1}`, s: mid + 1, e: end, stake }] : []),
      { label: `all ${end - start + 1}`, s: start, e: end, stake },
      ...pressesFor(round, 'roundrobin').filter(p => p.s >= start && p.s <= end)
        .map((p, i) => ({ label: `press from ${p.s + 1}`, s: p.s, e: Math.min(p.e, end), stake: p.stake ?? stake })),
    ];
    matches.forEach(mt => runMatch(round, A, B, mt, total, log, `Sixes ${s + 1}`));
  }
  return { money: total, points: null, log };
}

function calcWolf(round, stake) {
  const n = round.players.length, pts = zero(round), log = [];
  for (const h of playedHoles(round)) {
    const wolf = round.players[h % n].id;
    const call = round.wolf?.[h];
    if (!call) { log.push({ h, text: `${nameOf(round, wolf)} has the wolf, no call in`, m: zero(round), pending: true }); continue; }
    const wSide = call === 'lone' ? [wolf] : [wolf, call];
    const others = round.players.map(p => p.id).filter(id => !wSide.includes(id));
    const a = Math.min(...wSide.map(id => net(round, id, h)));
    const b = Math.min(...others.map(id => net(round, id, h)));
    const m = zero(round); let text;
    if (a < b) {
      if (call === 'lone') { m[wolf] = 4; text = `${nameOf(round, wolf)} goes lone and wins, 4 points`; }
      else { wSide.forEach(id => m[id] = 2); text = `${nameOf(round, wolf)} + ${nameOf(round, call)} win, 2 each`; }
    } else if (b < a) {
      if (call === 'lone') { others.forEach(id => m[id] = 1); text = 'Lone wolf caught, 1 point each to the field'; }
      else { others.forEach(id => m[id] = 3); text = `Field takes it, 3 each to ${others.map(id => nameOf(round, id)).join(' + ')}`; }
    } else text = 'Halved, no points';
    addInto(pts, m);
    log.push({ h, text, m });
  }
  return { money: settle(round, pts, stake), points: pts, log };
}

const combine = (a, b, flip) => {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return Number(flip ? `${hi}${lo}` : `${lo}${hi}`);
};

/* Vegas for any even field. Every team plays every other team on every hole.
   Two flip rules:
     ditty   - a birdie only flips the number of the team you beat it against
     maxpain - one birdie anywhere flips every team that did not birdie, in
               every matchup, so the whole field cashes in on it */
function calcVegas(round, stake) {
  const total = zero(round), log = [];
  const tag = (t) => t.map(id => short(nameOf(round, id))).join('/');

  for (const h of playedHoles(round)) {
    const tms = round.players.length > 4 || round.blindDraw ? vegasTeamsAt(round, h) : teamsAt(round, h);
    if (!tms || tms.length < 2) continue;
    const par = round.pars[h];
    const on = round.vegasFlip !== false;
    const info = tms.map(t => {
      const sc = t.map(id => net(round, id, h));
      return {
        sc,
        grossBirdie: on && t.some(id => { const g = gross(round, id, h); return g != null && g <= par - 1; }),
        netBirdie: on && sc.some(s => s <= par - 1),
      };
    });
    const anyGross = info.some(x => x.grossBirdie);
    const maxPain = round.vegasPain === 'maxpain';

    /* House rule: only a GROSS birdie flips. A NET birdie cancels the flip for
       the team that has it, but never causes one.
         maxpain - any gross birdie flips every team that has no net birdie
         ditty   - your opponent's gross birdie flips you, unless you have a net
                   birdie of your own to cancel it */
    const numFor = (i, j) => {
      const flip = maxPain ? (anyGross && !info[i].netBirdie) : (info[j].grossBirdie && !info[i].netBirdie);
      return combine(info[i].sc[0], info[i].sc[1], flip);
    };

    const m = zero(round), pts = tms.map(() => 0);
    for (let i = 0; i < tms.length; i++) {
      for (let j = i + 1; j < tms.length; j++) {
        const a = numFor(i, j), b = numFor(j, i);
        const diff = Math.abs(a - b);
        if (!diff) continue;
        const [w, l] = a < b ? [i, j] : [j, i];
        const v = diff * stake / 2;
        tms[w].forEach(id => { m[id] = (m[id] || 0) + v; });
        tms[l].forEach(id => { m[id] = (m[id] || 0) - v; });
        pts[w] += diff; pts[l] -= diff;
      }
    }
    addInto(total, m);

    const shown = tms.map((t, i) => {
      const nat = combine(info[i].sc[0], info[i].sc[1], false);
      const flipped = maxPain && anyGross && !info[i].netBirdie;
      return `${tag(t)} ${flipped ? combine(info[i].sc[0], info[i].sc[1], true) : nat}${info[i].netBirdie ? '🐦' : ''} ${pts[i] > 0 ? '+' : ''}${pts[i]}`;
    }).join('  ·  ');
    const head = anyGross ? (maxPain ? 'Max pain, everybody flips. ' : 'Birdie flip. ') : '';
    log.push({ h, text: head + shown, m });
  }
  return { money: total, points: null, log };
}

function calcHammer(round, stake) {
  const total = zero(round), log = [];
  for (const h of playedHoles(round)) {
    const [A, B] = teamsAt(round, h) || sidesOf(round);
    const st = round.hammer?.[h] || {}, mult = st.mult || 1, val = stake * mult, m = zero(round);
    let win = null, text = '';
    if (st.conceded === 'A') { win = B; text = `${A.map(i => nameOf(round, i)).join(' + ')} concede`; }
    else if (st.conceded === 'B') { win = A; text = `${B.map(i => nameOf(round, i)).join(' + ')} concede`; }
    else {
      const a = sideNet(round, A, h), b = sideNet(round, B, h);
      if (a < b) win = A; else if (b < a) win = B;
      text = win ? `${win.map(i => nameOf(round, i)).join(' + ')} win the hole` : 'Halved';
    }
    if (win) {
      const lose = win === A ? B : A;
      win.forEach(id => m[id] = val / win.length);
      lose.forEach(id => m[id] = -val / lose.length);
      addInto(total, m);
    }
    log.push({ h, text: `${text} at ${mult}x, ${money(val)}`, m });
  }
  return { money: total, points: null, log };
}

function calcPoints(round, stake) {
  const split = round.pointsSplit || oddSplit(round.players.length);
  const pts = zero(round), log = [];
  for (const h of playedHoles(round)) {
    const rows = round.players.map(p => ({ id: p.id, n: net(round, p.id, h) })).sort((a, b) => a.n - b.n);
    const m = allocate(rows, split);
    addInto(pts, m);
    log.push({ h, text: rows.map(r => `${nameOf(round, r.id)} ${fmtP(m[r.id])}`).join('  ·  '), m });
  }
  return { money: settle(round, pts, stake), points: pts, log };
}

function calcStableford(round, stake) {
  const pts = zero(round), log = [];
  const val = (rel) => (rel <= -3 ? 5 : rel === -2 ? 4 : rel === -1 ? 3 : rel === 0 ? 2 : rel === 1 ? 1 : 0);
  for (const h of playedHoles(round)) {
    const m = zero(round);
    round.players.forEach(p => { m[p.id] = val(net(round, p.id, h) - round.pars[h]); });
    addInto(pts, m);
    log.push({ h, text: round.players.map(p => `${nameOf(round, p.id)} ${m[p.id]}`).join('  ·  '), m });
  }
  return { money: settle(round, pts, stake), points: pts, log };
}

function calcBBB(round, stake) {
  const pts = zero(round), log = [];
  const keys = [['bingo', 'first on'], ['bango', 'closest'], ['bongo', 'first in']];
  for (let h = 0; h < round.holes; h++) {
    const rec = round.bbb?.[h]; if (!rec) continue;
    const m = zero(round), parts = [];
    for (const [k, lbl] of keys) if (rec[k]) { m[rec[k]] = (m[rec[k]] || 0) + 1; parts.push(`${lbl} ${nameOf(round, rec[k])}`); }
    if (!parts.length) continue;
    addInto(pts, m);
    log.push({ h, text: parts.join('  ·  '), m });
  }
  return { money: settle(round, pts, stake), points: pts, log };
}

function calcYardage(round, rate) {
  const total = zero(round), log = [], n = round.players.length;
  for (const h of playedHoles(round)) {
    const yds = Number(round.yards?.[h]) || defYards(round.pars[h]);
    const val = r2(yds * rate);
    const nets = round.players.map(p => ({ id: p.id, n: net(round, p.id, h) }));
    const low = Math.min(...nets.map(x => x.n));
    const w = nets.filter(x => x.n === low);
    if (w.length !== 1) { log.push({ h, text: `${yds} yds, ${money(val)} halved`, m: zero(round) }); continue; }
    const m = zero(round);
    const each = round.yardMode === 'split' ? r2(val / (n - 1)) : val;
    round.players.forEach(p => { m[p.id] = p.id === w[0].id ? each * (n - 1) : -each; });
    addInto(total, m);
    log.push({ h, text: `${yds} yds, ${money(val)}, ${nameOf(round, w[0].id)} takes it`, m });
  }
  return { money: total, points: null, log };
}

const ENGINES = { skins: calcSkins, nassau: calcNassau, wolf: calcWolf, vegas: calcVegas, hammer: calcHammer, points: calcPoints, roundrobin: calcRoundRobin, yardage: calcYardage, stableford: calcStableford, bbb: calcBBB };

/* --- junk, including the escalating snake --- */
/* Junk can climb the same way the snake does. The count is kept per type, so
   the third barkie is worth more than the first barkie, while the sandies are
   still down at the bottom of their own ladder. */
const junkLadder = (round, base, k) => {
  if (!round.junkEscalate || k < 1) return base;
  return round.junkMode === 'double' ? base * Math.pow(2, k - 1) : base * k;
};

const snakeValue = (round, passes) => {
  const base = Number(round.snakeBase) || 1;
  if (!passes) return 0;
  return round.snakeMode === 'double' ? base * Math.pow(2, passes - 1) : base * passes;
};

function calcJunk(round) {
  const total = zero(round), log = [], n = round.players.length;
  const seen = {};
  if (!round.junkOn?.length) return { money: total, log, snakeHolder: null, snakePasses: 0, snakeVal: 0, seen };

  let snakeHolder = null, snakePasses = 0, snakeHole = null;
  const baseOf = (t) => Number(round.junkValues?.[t] ?? round.junkValue) || 1;

  const pay = (pid, sign, amount, label, h) => {
    const m = zero(round);
    round.players.forEach(p => { m[p.id] = p.id === pid ? sign * amount * (n - 1) : -sign * amount; });
    addInto(total, m);
    log.push({ h, text: label, m, junk: true });
  };

  for (let h = 0; h < round.holes; h++) {
    const rec = round.junk?.[h] || {};

    if (round.junkOn.includes('birdie') && holeComplete(round, h)) {
      for (const p of round.players) {
        const sc = round.useNet ? net(round, p.id, h) : gross(round, p.id, h);
        const under = round.pars[h] - sc;
        if (under < 1) continue;
        seen.birdie = (seen.birdie || 0) + 1;
        const amt = r2(junkLadder(round, baseOf('birdie'), seen.birdie) * under);
        const word = under >= 3 ? 'albatross' : under === 2 ? 'eagle' : 'birdie';
        pay(p.id, 1, amt, `${p.name} ${word}, ${money(amt)} from each man`, h);
      }
    }

    for (const type of round.junkOn) {
      const def = JUNK[type], ids = rec[type] || [];
      if (!def || def.auto || !ids.length) continue;
      if (def.hold) {
        ids.forEach(pid => { snakePasses++; snakeHolder = pid; snakeHole = h; });
        continue;
      }
      for (const pid of ids) {
        seen[type] = (seen[type] || 0) + 1;
        const amt = r2(junkLadder(round, baseOf(type), seen[type]));
        pay(pid, def.sign, amt,
          `${nameOf(round, pid)} ${def.sign > 0 ? 'wins a' : 'pays a'} ${def.name.toLowerCase()}, ${money(amt)} each`, h);
      }
    }
  }

  const snakeVal = snakeValue(round, snakePasses);
  if (snakeHolder && snakeVal) {
    const m = zero(round);
    round.players.forEach(p => { m[p.id] = p.id === snakeHolder ? -snakeVal * (n - 1) : snakeVal; });
    addInto(total, m);
    log.push({ h: snakeHole, text: `${nameOf(round, snakeHolder)} is holding the snake at ${money(snakeVal)}`, m, live: true, junk: true });
  }
  return { money: total, log, snakeHolder, snakePasses, snakeVal, seen };
}

function fullLedger(round) {
  const total = zero(round), byGame = {}, log = [];
  for (const k of round.games) {
    const res = ENGINES[k](round, round.stakes[k]);
    byGame[k] = res;
    addInto(total, res.money);
    res.log.forEach(l => log.push({ ...l, game: k }));
  }
  const junk = calcJunk(round);
  addInto(total, junk.money);
  const solo = round.games.length === 1 ? byGame[round.games[0]] : null;
  return {
    money: total, byGame, log, junk,
    junkLog: junk.log, snakeHolder: junk.snakeHolder, snakeVal: junk.snakeVal, snakePasses: junk.snakePasses, junkSeen: junk.seen,
    points: solo?.points || null, extra: solo?.extra || null,
  };
}

/* ==========================================================================
   UI PRIMITIVES
   ========================================================================== */

const Btn = ({ children, onClick, active, kind = 'ghost', style = {}, disabled, tone }) => (
  <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{
    fontFamily: F_DISP, fontWeight: 700, fontSize: 13, letterSpacing: '0.03em',
    padding: '10px 14px', borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
    border: `1px solid ${active ? (tone || C.ball) : C.line}`, transition: 'all .12s',
    background: active ? (tone || C.ball) : kind === 'solid' ? C.chalk : 'transparent',
    color: active ? (tone && tone !== C.ball ? C.onTone : C.onBall)
      : kind === 'solid' ? C.felt : disabled ? C.line : C.chalk,
    opacity: disabled ? 0.35 : 1, ...style,
  }}>{children}</button>
);

const Eyebrow = ({ children, style = {} }) => (
  <div style={{ fontFamily: F_MONO, fontSize: 10, letterSpacing: '0.18em', color: C.muted, textTransform: 'uppercase', ...style }}>{children}</div>
);

const inputStyle = {
  background: C.card, border: `1px solid ${C.line}`, borderRadius: 10,
  padding: '12px 14px', color: C.chalk, fontFamily: F_DISP, fontWeight: 600, fontSize: 15, outline: 'none', width: '100%',
};

const Dots = ({ n, size = 6 }) => !n ? null : (
  <span style={{ display: 'inline-flex', gap: 2, verticalAlign: 'middle', marginLeft: 5 }}>
    {Array.from({ length: Math.min(n, 4) }).map((_, i) => (
      <span key={i} style={{ width: size, height: size, borderRadius: size, background: C.ball, display: 'inline-block' }} />
    ))}
  </span>
);

function Standings({ round, ledger, compact }) {
  const vals = round.players.map(p => ledger.money[p.id] || 0);
  const max = Math.max(1, ...vals.map(Math.abs));
  const sorted = [...round.players].sort((a, b) => (ledger.money[b.id] || 0) - (ledger.money[a.id] || 0));
  return (
    <div>
      {sorted.map((p, i) => {
        const v = ledger.money[p.id] || 0;
        const pct = (Math.abs(v) / max) * 48;
        const col = v > 0 ? C.up : v < 0 ? C.down : C.muted;
        return (
          <div key={p.id} style={{ position: 'relative', height: compact ? 32 : 42, marginBottom: 6 }}>
            <div style={{ position: 'absolute', inset: 0, background: C.card, borderRadius: 8 }} />
            <div style={{ position: 'absolute', left: '50%', top: 4, bottom: 4, width: 1, background: C.line }} />
            <div style={{
              position: 'absolute', top: 4, bottom: 4, left: v >= 0 ? '50%' : `${50 - pct}%`, width: `${pct}%`,
              background: col, opacity: 0.2, borderRadius: 6,
              borderRight: v > 0 ? `2px solid ${col}` : 'none', borderLeft: v < 0 ? `2px solid ${col}` : 'none',
              transition: 'all .35s cubic-bezier(.2,.8,.2,1)',
            }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 7 }}>
              <span style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, width: 13 }}>{i + 1}</span>
              <span style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: compact ? 13 : 15, color: C.chalk }}>{p.name}</span>
              {ledger.snakeHolder === p.id && <span style={{ fontSize: 12 }}>🐍</span>}
              {ledger.points && <span style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted }}>{fmtP(ledger.points[p.id] || 0)}p</span>}
              <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: compact ? 14 : 17, color: col }}>
                {v === 0 ? '—' : money(v)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   COURSE PICKER
   ========================================================================== */

/* Draw them out of a hat. Tap two names and they are a team, tap two more and
   they are the next team. Consecutive pairs are partners and every four make a
   group that keeps its own card, so your partner is always in your cart. */
function LineupBuilder({ names, count, lineup, setLineup, showTeams }) {
  const label = (i) => (names[i] || '').trim() || `Player ${i + 1}`;
  const all = Array.from({ length: count }, (_, i) => i);
  const pool = all.filter(i => !lineup.includes(i));
  const groups = chunk(lineup, 4);
  const waiting = lineup.length % 2 === 1 ? lineup[lineup.length - 1] : null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Eyebrow>{showTeams ? 'partners' : 'groups'}</Eyebrow>
        <span style={{ fontFamily: F_MONO, fontSize: 9.5, color: C.muted }}>{lineup.length} of {count}</span>
        <Btn onClick={() => setLineup([...all].sort(() => Math.random() - 0.5))} style={{ marginLeft: 'auto', fontSize: 10.5, padding: '7px 10px' }}>Shuffle</Btn>
        {!!lineup.length && <Btn onClick={() => setLineup(l => l.slice(0, -1))} style={{ fontSize: 10.5, padding: '7px 10px' }}>Undo</Btn>}
        {!!lineup.length && <Btn onClick={() => setLineup([])} style={{ fontSize: 10.5, padding: '7px 10px' }}>Clear</Btn>}
      </div>

      {!!pool.length && (
        <div style={{ background: C.card, borderRadius: 12, padding: '11px 12px', marginBottom: 8 }}>
          <Eyebrow style={{ color: C.ink, marginBottom: 8 }}>
            {showTeams
              ? (waiting != null ? `who is with ${short(label(waiting))}?` : 'tap two to make a team')
              : 'tap them in the order they are grouped'}
          </Eyebrow>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {pool.map(i => (
              <Btn key={i} onClick={() => setLineup(l => [...l, i])} style={{ fontSize: 12.5, padding: '10px 13px' }}>{label(i)}</Btn>
            ))}
          </div>
        </div>
      )}

      {!!lineup.length && (
        <div style={{ display: 'grid', gap: 8 }}>
          {groups.map((g, gi) => (
            <div key={gi} style={{ background: C.card, borderRadius: 12, padding: '10px 11px' }}>
              <Eyebrow style={{ marginBottom: 7 }}>group {gi + 1} · keeps its own card</Eyebrow>
              {chunk(g, 2).map((pair, pi) => {
                const solo = pair.length === 1;
                return (
                  <div key={pi} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    {showTeams && (
                      <span style={{ fontFamily: F_MONO, fontSize: 9, color: solo ? C.ink : C.muted, width: 30 }}>
                        {solo ? (pool.length ? '...' : 'solo') : `T${gi * 2 + pi + 1}`}
                      </span>
                    )}
                    {pair.map(i => (
                      <Btn key={i} onClick={() => setLineup(l => l.filter(x => x !== i))} style={{ flex: 1, fontSize: 12, padding: '9px 4px' }}>
                        {short(label(i))}
                      </Btn>
                    ))}
                    {solo && <div style={{ flex: 1 }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontFamily: F_MONO, fontSize: 9.5, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
        {pool.length
          ? 'Tap a placed name to send him back to the pool.'
          : showTeams ? 'Partners stay together all round.' : 'Each group posts its own card.'}
      </div>
    </div>
  );
}

/* Optional courses baked into the app that show up as a "your courses" quick
   pick without a search. Empty now that live search covers every course,
   including TPC River's Bend — everyone just searches for it. To pin a course
   back to the top for everyone, add an object here:
     { id, name, city, state, par:[18], hcp:[18], tees:{ TeeName:[18 yards] } } */
const BUILT_IN_COURSES = [];

function CoursePicker({ holes, pars, setPars, si, setSi, yards, setYards, showYards, courseName, setCourseName }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(0);
  const [openCourse, setOpenCourse] = useState(BUILT_IN_COURSES.length === 1 ? BUILT_IN_COURSES[0].id : null);
  const [picked, setPicked] = useState(null);   // a searched course whose tees are being chosen

  /* Drop a built-in course onto the card. Full 18-hole arrays; the round slices
     to however many holes are being played. */
  const applyBuiltIn = (bc, tee) => {
    setPars([...bc.par]);
    setSi([...bc.hcp]);
    setYards(bc.tees[tee].map(String));
    setCourseName(`${bc.name} · ${tee}`);
    setList(null); setErr(null);
  };
  const matchBuiltIn = (bc) => {
    const s = q.trim().toLowerCase();
    return !s || bc.name.toLowerCase().includes(s) || `${bc.city} ${bc.state}`.toLowerCase().includes(s);
  };

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { setList(await fn()); }
    catch { setErr('Could not reach the course database. Search by name, or set the card by hand below.'); setList(null); }
    setBusy(false);
  };

  const nearMe = () => {
    if (!navigator.geolocation) { setErr('This device will not share a location. Search by name instead.'); return; }
    setBusy(true); setErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => run(() => searchCourses({ lat: pos.coords.latitude, lng: pos.coords.longitude, radius: 30 })),
      () => { setBusy(false); setErr('Location is off for this app. Search by name instead.'); },
      { timeout: 10000 }
    );
  };

  const pick = async (c) => {
    setBusy(true); setErr(null);
    try {
      const data = await loadCourse(c.id);
      const np = [...DEF_PAR], ns = [...DEF_SI], ny = [...DEF_YDS];
      let got = 0;
      data.holes.slice(0, 18).forEach((hd, i) => {
        if (hd.par) { np[i] = hd.par; got++; }
        if (hd.si) ns[i] = hd.si;
        if (hd.yds) ny[i] = hd.yds;
      });
      data.holes.slice(0, 18).forEach((hd, i) => { if (hd.par && !hd.yds) ny[i] = defYards(hd.par); });
      setPars(np); setSi(ns); setYards(ny); setCourseName(c.course_name); setList(null);
      if (!got) setErr(`${c.course_name} has no scorecard on file yet. Card is set to a standard par 72, adjust it below.`);
    } catch { setErr('Could not pull that scorecard. Set the card by hand below.'); }
    setBusy(false);
  };

  /* Apply a chosen tee from a searched (database) course. Fill any gaps in the
     data with defaults; only trust the handicap row if it is a full 1-18 set. */
  const fill18 = (arr, def) => Array.from({ length: 18 }, (_, i) => (arr && arr[i] != null) ? arr[i] : def[i]);
  const validSi = (a) => a && a.length >= 18 && a.slice(0, 18).every(x => x >= 1 && x <= 18) && new Set(a.slice(0, 18)).size >= 18;
  const applyDbTee = (course, tee) => {
    setPars(fill18(tee.par, DEF_PAR));
    setSi(validSi(tee.hcp) ? fill18(tee.hcp, DEF_SI) : [...DEF_SI]);
    setYards(fill18(tee.yards, DEF_YDS).map(String));
    setCourseName(`${course.name} · ${tee.label}`);
    setPicked(null); setList(null); setErr(null);
  };
  const searchByName = () => {
    if (!q.trim()) return;
    setPicked(null);
    run(() => COURSE_DB_ON ? searchCourseDb(q.trim()) : searchCourses({ q: q.trim() }));
  };

  const shownBuiltIns = BUILT_IN_COURSES.filter(matchBuiltIn);

  return (
    <div style={{ marginBottom: 18 }}>
      {!!shownBuiltIns.length && (
        <div style={{ marginBottom: 12 }}>
          <Eyebrow style={{ color: C.ink, marginBottom: 8 }}>your courses</Eyebrow>
          {shownBuiltIns.map(bc => {
            const open = openCourse === bc.id;
            const par = bc.par.slice(0, holes).reduce((a, b) => a + b, 0);
            return (
              <div key={bc.id} style={{ background: C.card2, border: `1px solid ${open ? C.ball : 'transparent'}`, borderRadius: 12, padding: '11px 12px', marginBottom: 8 }}>
                <div onClick={() => setOpenCourse(open ? null : bc.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 15, color: C.chalk }}>{bc.name}</div>
                    <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 2 }}>{bc.city}, {bc.state} · par {par}</div>
                  </div>
                  <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 10.5, color: C.ink, whiteSpace: 'nowrap' }}>{open ? 'pick tees' : 'tap to pick'}</span>
                </div>
                {open && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {Object.keys(bc.tees).map(tee => {
                      const on = courseName === `${bc.name} · ${tee}`;
                      const yds = bc.tees[tee].slice(0, holes).reduce((a, b) => a + b, 0);
                      return (
                        <Btn key={tee} active={on} onClick={() => applyBuiltIn(bc, tee)} style={{ flex: '1 1 62px', fontSize: 12, padding: '9px 4px', lineHeight: 1.25 }}>
                          {tee}<br /><span style={{ fontFamily: F_MONO, fontSize: 9, color: on ? C.onBall : C.muted }}>{yds} yds</span>
                        </Btn>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ fontFamily: F_MONO, fontSize: 9, color: C.muted, textAlign: 'center', marginTop: 2 }}>or search for another course below</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <Btn onClick={nearMe} style={{ flex: 1, fontSize: 12 }}>Courses near me</Btn>
        <Btn onClick={searchByName} disabled={!q.trim()} style={{ flex: 1, fontSize: 12 }}>Search by name</Btn>
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchByName()} placeholder="Course name" style={{ ...inputStyle, marginBottom: 8 }} />

      {busy && <div style={{ fontFamily: F_MONO, fontSize: 11, color: C.ink, padding: '6px 0' }}>Looking...</div>}
      {err && <div style={{ fontFamily: F_DISP, fontSize: 12, color: C.down, lineHeight: 1.5, marginBottom: 8 }}>{err}</div>}

      {courseName && !list && !picked && (
        <div style={{ background: C.card2, borderRadius: 10, padding: '10px 12px', marginBottom: 10, border: `1px solid ${C.ball}` }}>
          <Eyebrow style={{ color: C.ink }}>playing</Eyebrow>
          <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 15, color: C.chalk, marginTop: 2 }}>{courseName}</div>
        </div>
      )}

      {/* a searched course is chosen — pick which tees */}
      {picked && (
        <div style={{ background: C.card2, border: `1px solid ${C.ball}`, borderRadius: 12, padding: '11px 12px', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 15, color: C.chalk }}>{picked.name}</div>
              <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 2 }}>{[picked.city, picked.state].filter(Boolean).join(', ')}</div>
            </div>
            <Btn onClick={() => setPicked(null)} style={{ marginLeft: 'auto', fontSize: 10.5, padding: '6px 9px' }}>Back</Btn>
          </div>
          <Eyebrow style={{ color: C.ink, marginBottom: 7 }}>which tees</Eyebrow>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {picked.tees.map((t, i) => {
              const on = courseName === `${picked.name} · ${t.label}`;
              return (
                <Btn key={i} active={on} onClick={() => applyDbTee(picked, t)} style={{ flex: '1 1 68px', fontSize: 11.5, padding: '9px 4px', lineHeight: 1.25 }}>
                  {t.label}<br /><span style={{ fontFamily: F_MONO, fontSize: 9, color: on ? C.onBall : C.muted }}>{t.total || '—'} yds</span>
                </Btn>
              );
            })}
          </div>
        </div>
      )}

      {list && !picked && (
        <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 10 }}>
          {!list.length && <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, padding: '10px 0' }}>Nothing came back. Try a shorter name.</div>}
          {list.map(c => c.tees ? (
            <div key={c.id} onClick={() => { setPicked(c); setList(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: C.card, borderRadius: 10, marginBottom: 5, cursor: 'pointer' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk }}>{c.name}</div>
                <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 2 }}>
                  {[c.city, c.state].filter(Boolean).join(', ')} · {c.tees.length} tee{c.tees.length === 1 ? '' : 's'}
                </div>
              </div>
              <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 10, color: C.ink, whiteSpace: 'nowrap' }}>pick tees ▸</span>
            </div>
          ) : (
            <div key={c.id} onClick={() => pick(c)} style={{ padding: '10px 12px', background: C.card, borderRadius: 10, marginBottom: 5, cursor: 'pointer' }}>
              <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk }}>{c.course_name}</div>
              <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 2 }}>
                {[c.city, c.state].filter(Boolean).join(', ')}{c.par ? ` · par ${c.par}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9,1fr)', gap: 4, margin: '10px 0' }}>
        {Array.from({ length: holes }).map((_, i) => (
          <button key={i} onClick={() => setSel(i)} style={{
            padding: '6px 0', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${sel === i ? C.ball : C.line}`, background: sel === i ? C.card2 : 'transparent',
            color: C.chalk, fontFamily: F_MONO, fontSize: 11,
          }}><div style={{ fontSize: 8, color: C.muted }}>{i + 1}</div>{pars[i]}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: C.card, padding: 12, borderRadius: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: F_MONO, fontSize: 11, color: C.muted, flex: 1 }}>Hole {sel + 1}</span>
        <span style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted }}>par</span>
        <Btn onClick={() => setPars(p => { const c = [...p]; c[sel] = c[sel] >= 5 ? 3 : c[sel] + 1; return c; })}>{pars[sel]}</Btn>
        <span style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted }}>index</span>
        <Btn onClick={() => setSi(s => { const c = [...s]; c[sel] = c[sel] >= 18 ? 1 : c[sel] + 1; return c; })}>{si[sel]}</Btn>
        {showYards && (
          <>
            <span style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted }}>yards</span>
            <input value={yards[sel]} inputMode="numeric"
              onChange={e => setYards(y => { const c = [...y]; c[sel] = e.target.value.replace(/\D/g, ''); return c; })}
              style={{ ...inputStyle, width: 66, flex: '0 0 66px', padding: '8px 4px', textAlign: 'center', fontFamily: F_MONO, fontSize: 13 }} />
          </>
        )}
      </div>
      <div style={{ fontFamily: F_MONO, fontSize: 9, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
        Par {pars.slice(0, holes).reduce((a, b) => a + b, 0)}. Index decides which holes give strokes.<br />
        {COURSE_DB_ON ? 'Course data via GolfCourseAPI.' : 'Course data © OpenStreetMap contributors, ODbL, via OpenGolfAPI.'}
      </div>
    </div>
  );
}

/* ==========================================================================
   SETUP
   ========================================================================== */

function Setup({ onStart, onBack, roster }) {
  const [step, setStep] = useState(0);
  const [rawCount, setRawCount] = useState(4);
  const [picked, setPicked] = useState(roster ? roster.slice(0, 4).map(p => p.id) : []);
  const [names, setNames] = useState(Array(16).fill(''));
  const [hcps, setHcps] = useState(Array(16).fill(''));
  const [games, setGames] = useState(['skins']);
  const [stakes, setStakes] = useState({});
  const [useNet, setUseNet] = useState(true);
  const [holes, setHoles] = useState(18);
  const [teamSwap, setTeamSwap] = useState(0);
  const [partnerMode, setPartnerMode] = useState('fixed');
  const [lineup, setLineup] = useState([]);
  const [vegasPain, setVegasPain] = useState('ditty');
  const [blindDraw, setBlindDraw] = useState(true);
  const [painWarn, setPainWarn] = useState(false);
  const [painSeen, setPainSeen] = useState(false);
  const [skinsCarry, setSkinsCarry] = useState(true);
  const [junkOn, setJunkOn] = useState([]);
  const [junkValue, setJunkValue] = useState('2');
  const [junkValues, setJunkValues] = useState({});
  const [junkEscalate, setJunkEscalate] = useState(false);
  const [junkMode, setJunkMode] = useState('linear');
  const [snakeBase, setSnakeBase] = useState('1');
  const [snakeMode, setSnakeMode] = useState('linear');
  const [openInfo, setOpenInfo] = useState(null);
  const [pars, setPars] = useState([...DEF_PAR]);
  const [si, setSi] = useState([...DEF_SI]);
  const [yards, setYards] = useState(DEF_YDS.map(String));
  const [yardMode, setYardMode] = useState('each');
  const [courseName, setCourseName] = useState('');
  const [showCourse, setShowCourse] = useState(true);

  const count = roster ? picked.length : rawCount;
  const setCount = setRawCount;
  const flow = roster ? ['group', 'games', 'junk'] : ['count', 'names', 'games', 'junk'];
  const cur = flow[step];
  const avail = Object.keys(GAMES).filter(k => GAMES[k].ok(count));
  useEffect(() => {
    setGames(g => { const keep = g.filter(k => avail.includes(k)); return keep.length ? keep : [avail[0]]; });
    setLineup([]);
  }, [count]); // eslint-disable-line

  const setAt = (setter) => (i, v) => setter(a => { const c = [...a]; c[i] = v; return c; });
  const setName = setAt(setNames), setHcp = setAt(setHcps);
  const bigField = count > 4;
  const teamGame = games.some(k => GAMES[k].teams === true);
  const needsTeams = count === 4 && games.some(k => GAMES[k].teams === true || GAMES[k].teams === 'optional');
  const oddMan = count % 2 === 1 && teamGame;
  /* partners must be drawn before you tee off; grouping alone can fall back to listed order */
  const lineupReady = !bigField || !teamGame || lineup.length === count;
  const teamOrder = lineup.length === count ? lineup : Array.from({ length: count }, (_, i) => i);
  /* One birdie in Max Pain flips every other team in every matchup, so the
     exposure grows with the square of the field. Show them the number. */
  const vTeams = Math.floor(count / 2) + (count % 2);
  const vMatch = vTeams * (vTeams - 1) / 2;
  const bigPain = games.includes('vegas') && vegasPain === 'maxpain' && count > 8;
  const painHole = (rate) => r2(30 * (vTeams - 1) * rate);
  const stakeOf = (k) => (stakes[k] ?? GAMES[k].defStake);

  const toggleGame = (k) => setGames(g => g.includes(k) ? (g.length > 1 ? g.filter(x => x !== k) : g) : [...g, k]);

  const start = () => {
    const players = roster
      ? roster.filter(p => picked.includes(p.id))
      : names.slice(0, count).map((n, i) => ({ id: uid(), name: n.trim() || `Player ${i + 1}`, hcp: Number(hcps[i]) || 0 }));
    const ids = teamOrder.map(x => players[x].id);
    const groups = chunk(ids, 4);
    let teams = null;
    if (bigField && teamGame) {
      teams = chunk(ids, 2);
    } else if (needsTeams) {
      const pr = PAIRINGS[teamSwap];
      teams = [pr[0].map(i => players[i].id), pr[1].map(i => players[i].id)];
    }
    onStart({
      games, players, teams, holes, useNet,
      stakes: Object.fromEntries(games.map(k => [k, Number(stakeOf(k)) || 1])),
      course: courseName, pars: pars.slice(0, holes), si: si.slice(0, holes),
      yards: yards.slice(0, holes).map((y, i) => Number(y) || defYards(pars[i])), yardMode,
      scores: {}, wolf: {}, hammer: {}, bbb: {}, junk: {}, presses: [], holeTeams: {},
      pointsSplit: oddSplit(count), partnerMode, vegasFlip: true, vegasPain, skinsCarry,
      groups, blindDraw: oddMan && blindDraw,
      junkOn, junkValue: Number(junkValue) || 1, junkValues, junkEscalate, junkMode,
      snakeBase: Number(snakeBase) || 1, snakeMode,
      startedAt: Date.now(),
    });
  };

  const STEPS = roster ? ['Group', 'Games', 'Junk'] : ['Players', 'Names', 'Games', 'Junk'];
  const okToGo = (!roster || (picked.length >= 2 && avail.length)) && (cur !== 'games' || lineupReady);
  const NAV = (last) => (
    <div style={{ marginTop: 14 }}>
      {cur === 'games' && !lineupReady && (
        <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.down, marginBottom: 8, lineHeight: 1.6 }}>
          {count - lineup.length} still to place. Tap them into teams above, or hit Shuffle.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
      <Btn onClick={() => (step > 0 ? setStep(step - 1) : onBack && onBack())} style={{ flex: '0 0 88px' }}>Back</Btn>
      <Btn kind="solid" disabled={!okToGo} onClick={() => (last ? start() : setStep(step + 1))}
        style={{ flex: 1, padding: 16, fontSize: 15 }}>{last ? 'Tee it up' : 'Next'}</Btn>
      </div>
    </div>
  );

  return (
    <div style={{ padding: '20px 16px 40px', maxWidth: 520, margin: '0 auto' }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 30, letterSpacing: '-0.03em', color: C.chalk, lineHeight: 0.95 }}>{APP_NAME}</div>
        <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 30, letterSpacing: '-0.03em', color: C.ink, lineHeight: 0.95 }}>{APP_SUB}</div>
      </div>


      <div style={{ display: 'flex', gap: 4, marginBottom: 22 }}>
        {STEPS.map((s, i) => (
          <div key={s} onClick={() => i < step && setStep(i)} style={{ flex: 1, cursor: i < step ? 'pointer' : 'default' }}>
            <div style={{ height: 3, borderRadius: 2, background: i <= step ? C.ball : C.line, marginBottom: 6 }} />
            <div style={{ fontFamily: F_MONO, fontSize: 9, letterSpacing: '0.14em', color: i <= step ? C.chalk : C.muted, textTransform: 'uppercase' }}>{s}</div>
          </div>
        ))}
      </div>

      {painWarn && (
        <div onClick={() => setPainWarn(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(6,14,10,.82)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.felt, borderTop: `1px solid ${C.down}`, borderRadius: '18px 18px 0 0', padding: '22px 18px 26px', width: '100%', maxWidth: 520 }}>
            <Eyebrow style={{ color: C.down }}>before you pick this</Eyebrow>
            <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 23, color: C.chalk, letterSpacing: '-0.02em', marginTop: 6 }}>
              Max Pain with {count} gets loud
            </div>
            <div style={{ fontFamily: F_DISP, fontSize: 13.5, color: C.muted, marginTop: 8, lineHeight: 1.55 }}>
              You have {vTeams} teams, which is {vMatch} matchups on every hole. One birdie anywhere on the course flips
              all {vTeams - 1} of your opponents at the same time, in every one of those matchups.
            </div>

            <div style={{ background: C.card, borderRadius: 12, padding: '13px 14px', margin: '16px 0' }}>
              <Eyebrow style={{ marginBottom: 8 }}>a rough single hole swing for one team</Eyebrow>
              {[0.01, 0.05, 0.1, 0.25, 1].map(r => (
                <div key={r} style={{ display: 'flex', alignItems: 'baseline', padding: '5px 0' }}>
                  <span style={{ fontFamily: F_MONO, fontSize: 12, color: C.muted }}>{money(r)} a point</span>
                  <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: 14, color: painHole(r) >= 100 ? C.down : C.chalk }}>
                    {money(painHole(r))}
                  </span>
                </div>
              ))}
              <div style={{ fontFamily: F_MONO, fontSize: 9.5, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
                And that is one hole. Multiply by eighteen for the day.
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={() => { setVegasPain('ditty'); setPainWarn(false); }} style={{ flex: 1, padding: 15, fontSize: 13 }}>Use Ditty instead</Btn>
              <Btn kind="solid" onClick={() => setPainWarn(false)} style={{ flex: 1, padding: 15, fontSize: 13 }}>We know, keep it</Btn>
            </div>
          </div>
        </div>
      )}

      {cur === 'group' && (
        <>
          <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 21, color: C.chalk, marginBottom: 4 }}>Who is in this group?</div>
          <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginBottom: 18 }}>
            Tap the guys playing this round. The rest of the trip carries on without them.
          </div>
          <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            {(roster || []).map(p => {
              const on = picked.includes(p.id);
              return (
                <div key={p.id} onClick={() => setPicked(x => on ? x.filter(i => i !== p.id) : [...x, p.id])}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', cursor: 'pointer',
                    background: on ? C.card2 : C.card, borderRadius: 11, border: `1px solid ${on ? C.ball : 'transparent'}` }}>
                  <div style={{ width: 19, height: 19, flex: '0 0 19px', borderRadius: 5,
                    border: `1.5px solid ${on ? C.ball : C.line}`, background: on ? C.ball : 'transparent',
                    color: C.onBall, fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{on ? '✓' : ''}</div>
                  <span style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 15, color: C.chalk }}>{p.name}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 11, color: C.muted }}>{p.hcp > 0 ? `+${p.hcp}` : p.hcp}</span>
                </div>
              );
            })}
          </div>
          <div style={{ background: C.card, borderRadius: 12, padding: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>{picked.length} picked</Eyebrow>
            <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 13.5, color: picked.length >= 2 ? C.chalk : C.muted, lineHeight: 1.6 }}>
              {picked.length < 2 ? 'Pick at least two.' : avail.map(k => gameName(k, count)).join(' · ')}
            </div>
          </div>
          {NAV(false)}
        </>
      )}

      {cur === 'count' && (
        <>
          <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 21, color: C.chalk, marginBottom: 4 }}>How many are playing?</div>
          <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginBottom: 18 }}>This decides which games are on the table.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 7, marginBottom: 20 }}>
            {Array.from({ length: 15 }, (_, i) => i + 2).map(n => (
              <button key={n} onClick={() => setCount(n)} style={{
                padding: '15px 0', borderRadius: 11, cursor: 'pointer',
                border: `1px solid ${count === n ? C.ball : C.line}`, background: count === n ? C.ball : C.card,
                color: count === n ? C.onBall : C.chalk, fontFamily: F_MONO, fontWeight: 700, fontSize: 18,
              }}>{n}</button>
            ))}
          </div>
          <div style={{ background: C.card, borderRadius: 12, padding: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>on the table with {count}</Eyebrow>
            <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk, lineHeight: 1.6 }}>
              {avail.map(k => gameName(k, count)).join(' · ')}
            </div>
          </div>
          {NAV(false)}
        </>
      )}

      {cur === 'names' && (
        <>
          <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 21, color: C.chalk, marginBottom: 4 }}>Who is out there?</div>
          <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginBottom: 18 }}>Leave the handicap blank to play everything gross.</div>
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={names[i]} onChange={e => setName(i, e.target.value)} placeholder={`Player ${i + 1}`} style={inputStyle} />
              <input value={hcps[i]} onChange={e => setHcp(i, e.target.value)} placeholder="hcp" inputMode="text"
                style={{ ...inputStyle, width: 70, flex: '0 0 70px', textAlign: 'center' }} />
            </div>
          ))}
          {NAV(false)}
        </>
      )}

      {cur === 'games' && (
        <>
          <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 21, color: C.chalk, marginBottom: 4 }}>What are you playing?</div>
          <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginBottom: 18 }}>
            Pick as many as you want. They all run at the same time off one scorecard.
          </div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 20 }}>
            {avail.map(k => {
              const on = games.includes(k);
              return (
                <div key={k} style={{ background: on ? C.card2 : C.card, borderRadius: 12, border: `1px solid ${on ? C.ball : 'transparent'}`, overflow: 'hidden' }}>
                  <div onClick={() => toggleGame(k)} style={{ display: 'flex', gap: 10, padding: '13px 14px', cursor: 'pointer' }}>
                    <div style={{
                      width: 19, height: 19, flex: '0 0 19px', borderRadius: 5, marginTop: 1,
                      border: `1.5px solid ${on ? C.ball : C.line}`, background: on ? C.ball : 'transparent',
                      color: C.onBall, fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>{on ? '✓' : ''}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 16, color: on ? C.ink : C.chalk }}>{gameName(k, count)}</div>
                      <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.4 }}>{GAMES[k].blurb(count)}</div>
                    </div>
                  </div>
                  {on && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 14px 13px 43px' }}>
                      <span style={{ fontFamily: F_MONO, fontSize: 16, color: C.muted }}>$</span>
                      <input value={stakeOf(k)} onChange={e => setStakes(s => ({ ...s, [k]: e.target.value }))} inputMode="decimal"
                        style={{ ...inputStyle, width: 78, flex: '0 0 78px', padding: '8px 6px', textAlign: 'center', fontFamily: F_MONO }} />
                      <span style={{ fontFamily: F_MONO, fontSize: 11, color: C.muted }}>{GAMES[k].unit}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {needsTeams && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>teams</Eyebrow>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {PAIRINGS.map((p, i) => (
                  <Btn key={i} active={teamSwap === i} onClick={() => setTeamSwap(i)} style={{ flex: 1, fontSize: 10, padding: '10px 3px' }}>
                    {p.map(t => t.map(x => (names[x] || `P${x + 1}`).slice(0, 4)).join('/')).join(' v ')}
                  </Btn>
                ))}
              </div>
            </>
          )}

          {games.includes('skins') && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>tied holes in skins</Eyebrow>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <Btn active={skinsCarry} onClick={() => setSkinsCarry(true)} style={{ flex: 1, fontSize: 11.5 }}>Carry over</Btn>
                <Btn active={!skinsCarry} onClick={() => setSkinsCarry(false)} style={{ flex: 1, fontSize: 11.5 }}>Wash</Btn>
              </div>
              <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, lineHeight: 1.6, marginBottom: 18 }}>
                {skinsCarry
                  ? 'A halved hole rolls into the next one and the pot builds.'
                  : 'A halved hole is gone. Every hole is worth the same all day.'}
              </div>
            </>
          )}

          {bigField && (
            <>
              <LineupBuilder names={names} count={count} lineup={lineup} setLineup={setLineup} showTeams={teamGame} />
              <div style={{ background: C.card2, borderRadius: 11, padding: '11px 13px', marginBottom: 18 }}>
                <Eyebrow style={{ color: C.ink, marginBottom: 5 }}>one card per group</Eyebrow>
                <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55 }}>
                  You only see your own foursome out there, so each group posts its own scores. Send everyone the code.
                  One man in each group taps Keep score and picks his group, and it all lands on the same leaderboard.
                </div>
              </div>
            </>
          )}

          {oddMan && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>odd man out</Eyebrow>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <Btn active={blindDraw} onClick={() => setBlindDraw(true)} style={{ flex: 1, fontSize: 11.5 }}>Blind draw</Btn>
                <Btn active={!blindDraw} onClick={() => setBlindDraw(false)} style={{ flex: 1, fontSize: 11.5 }}>Sit him out</Btn>
              </div>
              <div style={{ background: C.card, borderRadius: 11, padding: '11px 13px', marginBottom: 18 }}>
                <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55 }}>
                  {blindDraw
                    ? `With ${count} playing, one man has no partner. Blind draw gives him a random one on every hole, pulled the moment the hole is posted so he is in it the whole way instead of waiting until the end. His drawn partner still plays for his own team too.`
                    : 'He plays his own ball but sits out the team bet.'}
                </div>
              </div>
            </>
          )}

          {games.includes('vegas') && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>vegas flip rule</Eyebrow>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <Btn active={vegasPain === 'ditty'} onClick={() => setVegasPain('ditty')} style={{ flex: 1, fontSize: 11.5 }}>Ditty</Btn>
                <Btn active={vegasPain === 'maxpain'} tone={C.down} style={{ flex: 1, fontSize: 11.5 }}
                  onClick={() => { setVegasPain('maxpain'); if (count > 8 && !painSeen) { setPainWarn(true); setPainSeen(true); } }}>Max Pain</Btn>
              </div>
              <div style={{ background: C.card, borderRadius: 11, padding: '11px 13px', marginBottom: 18 }}>
                <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55 }}>
                  {vegasPain === 'ditty'
                    ? 'A birdie only flips the team you beat it against. Your good hole is your business.'
                    : 'One birdie anywhere flips every team that did not birdie, in every matchup. Everybody rides somebody else\u2019s birdie.'}
                </div>
                <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, lineHeight: 1.6, marginTop: 7 }}>
                  Say you shoot 44 and another team shoots 47 while a third team birdies. Ditty pays you 3 off them.
                  Max Pain turns their 47 into a 74 and pays you 30.
                </div>
              </div>

              {bigPain && (
                <div style={{ background: C.card, border: `1px solid ${C.down}`, borderRadius: 11, padding: '12px 13px', marginBottom: 18 }}>
                  <Eyebrow style={{ color: C.down, marginBottom: 6 }}>this escalates fast</Eyebrow>
                  <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55 }}>
                    {count} players is {vTeams} teams and {vMatch} matchups every hole. In Max Pain one birdie anywhere
                    flips all {vTeams - 1} of your opponents at once, so a single hole can swing a team about{' '}
                    <span style={{ color: C.down, fontWeight: 700 }}>{money(painHole(Number(stakeOf('vegas')) || 0))}</span> at {money(Number(stakeOf('vegas')) || 0)} a point.
                  </div>
                  <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, lineHeight: 1.6, marginTop: 7 }}>
                    A penny a point puts that at {money(painHole(0.01))}. Agree on the number on the first tee, not the eighteenth green.
                  </div>
                </div>
              )}
            </>
          )}

          {count === 4 && games.some(k => PARTNER_GAMES.includes(k)) && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>partners</Eyebrow>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <Btn active={partnerMode === 'fixed'} onClick={() => setPartnerMode('fixed')} style={{ flex: 1, fontSize: 11.5 }}>Same all day</Btn>
                <Btn active={partnerMode === 'rotate'} onClick={() => setPartnerMode('rotate')} style={{ flex: 1, fontSize: 11.5 }}>Change each hole</Btn>
              </div>
              <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, lineHeight: 1.6, marginBottom: 18 }}>
                {partnerMode === 'rotate'
                  ? `Set the pairing on every tee. Left/right Vegas works this way, the two balls furthest right play together. Applies to ${games.filter(k => PARTNER_GAMES.includes(k)).map(k => gameName(k, count)).join(' and ')}.`
                  : 'One pairing for the whole round.'}
                {games.includes('nassau') ? ' Nassau keeps the same two sides either way.' : ''}
              </div>
            </>
          )}

          {games.includes('yardage') && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>who pays the yardage</Eyebrow>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <Btn active={yardMode === 'each'} onClick={() => setYardMode('each')} style={{ flex: 1, fontSize: 11.5 }}>Everybody pays it</Btn>
                <Btn active={yardMode === 'split'} onClick={() => setYardMode('split')} style={{ flex: 1, fontSize: 11.5 }}>Split the hole</Btn>
              </div>
              <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, lineHeight: 1.6, marginBottom: 18 }}>
                {(() => {
                  const rate = Number(stakeOf('yardage')) || 0.1;
                  const val = r2(400 * rate);
                  return yardMode === 'each'
                    ? `A 400 yard hole is ${money(val)}. Each of the other ${count - 1} pays that, so the winner takes ${money(val * (count - 1))}.`
                    : `A 400 yard hole is ${money(val)} total. The winner takes ${money(val)}, split ${count - 1} ways.`;
                })()}
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <Btn active={useNet} onClick={() => setUseNet(true)} style={{ flex: 1 }}>Net</Btn>
            <Btn active={!useNet} onClick={() => setUseNet(false)} style={{ flex: 1 }}>Gross</Btn>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <Btn active={holes === 18} onClick={() => setHoles(18)} style={{ flex: 1 }}>18 holes</Btn>
            <Btn active={holes === 9} onClick={() => setHoles(9)} style={{ flex: 1 }}>9 holes</Btn>
          </div>

          {games.some(isPointGame) && (() => {
            const pg = games.find(isPointGame);
            const rate = Number(stakeOf(pg)) || 0;
            return (
              <div style={{ background: C.card, borderRadius: 11, padding: '11px 13px', marginBottom: 18 }}>
                <Eyebrow style={{ marginBottom: 6 }}>how points pay</Eyebrow>
                <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55 }}>
                  Every man settles the point difference with every other man. With {count} playing at {money(rate)} a point,
                  finishing 10 points clear of the field is worth {money(r2(rate * count * 10))}.
                </div>
              </div>
            );
          })()}

          <div onClick={() => setShowCourse(s => !s)} style={{ cursor: 'pointer', marginBottom: 10, background: C.card, borderRadius: 12, padding: '13px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <Eyebrow style={{ color: C.ink }}>the course</Eyebrow>
              <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {courseName || 'Pick your course or set the card'}
              </div>
            </div>
            <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 13, color: C.muted }}>{showCourse ? '▴' : '▾'}</span>
          </div>
          {showCourse && <CoursePicker holes={holes} pars={pars} setPars={setPars} si={si} setSi={setSi}
            yards={yards} setYards={setYards} showYards={games.includes('yardage')}
            courseName={courseName} setCourseName={setCourseName} />}

          {NAV(false)}
        </>
      )}

      {cur === 'junk' && (
        <>
          <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 21, color: C.chalk, marginBottom: 4 }}>Adding any junk?</div>
          <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginBottom: 18 }}>Side bets that ride on top. Tap the circle for the rules.</div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: F_MONO, fontSize: 20, color: C.muted }}>$</span>
            <input value={junkValue} onChange={e => setJunkValue(e.target.value)} inputMode="decimal" style={{ ...inputStyle, width: 90, flex: '0 0 90px', fontSize: 18 }} />
            <span style={{ fontFamily: F_MONO, fontSize: 11, color: C.muted, lineHeight: 1.4 }}>each, paid by every other player</span>
          </div>

          <Eyebrow style={{ marginBottom: 8 }}>does junk climb</Eyebrow>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <Btn active={!junkEscalate} onClick={() => setJunkEscalate(false)} style={{ flex: 1, fontSize: 11.5 }}>Flat</Btn>
            <Btn active={junkEscalate} onClick={() => setJunkEscalate(true)} style={{ flex: 1, fontSize: 11.5 }}>Escalating</Btn>
          </div>
          {junkEscalate && (
            <div style={{ background: C.card, borderRadius: 11, padding: '12px 13px', marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
                <Btn active={junkMode === 'linear'} onClick={() => setJunkMode('linear')} style={{ flex: 1, fontSize: 11 }}>Step up</Btn>
                <Btn active={junkMode === 'double'} onClick={() => setJunkMode('double')} style={{ flex: 1, fontSize: 11 }}>Double</Btn>
              </div>
              <div style={{ fontFamily: F_MONO, fontSize: 11, color: C.ink, lineHeight: 1.7, wordBreak: 'break-word' }}>
                {[1, 2, 3, 4, 5, 6].map(k => money(r2(junkMode === 'double'
                  ? (Number(junkValue) || 1) * Math.pow(2, k - 1)
                  : (Number(junkValue) || 1) * k))).join('  ·  ')} ...
              </div>
              <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55, marginTop: 9 }}>
                Counted per type. The third barkie is worth more than the first barkie, but the first sandie still
                starts at the bottom of its own ladder. Late holes are where it hurts.
              </div>
            </div>
          )}
          <div style={{ height: 10 }} />

          <div style={{ display: 'grid', gap: 6, marginBottom: 20 }}>
            {Object.entries(JUNK).map(([k, d]) => {
              const on = junkOn.includes(k);
              const tone = d.hold ? C.snake : d.sign > 0 ? C.ball : C.down;
              return (
                <div key={k} style={{ background: on ? C.card2 : C.card, borderRadius: 11, border: `1px solid ${on ? tone : 'transparent'}`, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px' }}>
                    <div onClick={() => setJunkOn(j => on ? j.filter(x => x !== k) : [...j, k])} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, cursor: 'pointer', minWidth: 0 }}>
                      <div style={{
                        width: 19, height: 19, borderRadius: 5, flex: '0 0 19px',
                        border: `1.5px solid ${on ? tone : C.line}`, background: on ? tone : 'transparent',
                        color: C.onBall, fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>{on ? '✓' : ''}</div>
                      <span style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 15, color: C.chalk }}>{d.name}</span>
                      {d.sign < 0 && <span style={{ fontFamily: F_MONO, fontSize: 9, color: tone, letterSpacing: '0.1em' }}>YOU PAY</span>}
                    </div>
                    {on && !d.hold && (
                      <input value={junkValues[k] ?? junkValue} onChange={e => setJunkValues(v => ({ ...v, [k]: e.target.value }))} inputMode="decimal"
                        style={{ ...inputStyle, width: 54, flex: '0 0 54px', padding: '7px 4px', textAlign: 'center', fontSize: 13, fontFamily: F_MONO }} />
                    )}
                    <button onClick={() => setOpenInfo(openInfo === k ? null : k)} aria-label={`what is a ${d.name}`} style={{
                      width: 22, height: 22, flex: '0 0 22px', borderRadius: 11, cursor: 'pointer',
                      border: `1px solid ${openInfo === k ? C.ball : C.line}`, background: 'transparent',
                      color: openInfo === k ? C.ink : C.muted, fontFamily: F_MONO, fontSize: 11, padding: 0,
                    }}>i</button>
                  </div>
                  {openInfo === k && <div style={{ padding: '0 13px 12px 42px', fontFamily: F_DISP, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{d.info}</div>}

                  {/* snake escalation */}
                  {on && d.hold && (
                    <div style={{ padding: '0 13px 13px 42px' }}>
                      <Eyebrow style={{ marginBottom: 7 }}>how it grows</Eyebrow>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        <Btn active={snakeMode === 'linear'} tone={C.snake} onClick={() => setSnakeMode('linear')} style={{ flex: 1, fontSize: 11 }}>Step up</Btn>
                        <Btn active={snakeMode === 'double'} tone={C.snake} onClick={() => setSnakeMode('double')} style={{ flex: 1, fontSize: 11 }}>Double</Btn>
                      </div>
                      <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                        {['0.25', '0.50', '1', '5'].map(v => (
                          <Btn key={v} active={snakeBase === v} tone={C.snake} onClick={() => setSnakeBase(v)} style={{ flex: 1, fontSize: 11, padding: '8px 2px' }}>
                            {money(Number(v))}
                          </Btn>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontFamily: F_MONO, fontSize: 14, color: C.muted }}>$</span>
                        <input value={snakeBase} onChange={e => setSnakeBase(e.target.value)} inputMode="decimal"
                          style={{ ...inputStyle, width: 70, flex: '0 0 70px', padding: '7px 4px', textAlign: 'center', fontSize: 13, fontFamily: F_MONO }} />
                        <span style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted }}>to start, cents are fine</span>
                      </div>
                      <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.snake, lineHeight: 1.6 }}>
                        {[1, 2, 3, 4, 5, 6].map(i => money(snakeMode === 'double'
                          ? (Number(snakeBase) || 1) * Math.pow(2, i - 1)
                          : (Number(snakeBase) || 1) * i)).join(' · ')} ...
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {NAV(true)}
          <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, textAlign: 'center', marginTop: 12 }}>
            {games.map(k => gameName(k, count)).join(' + ')}{junkOn.length ? ` + ${junkOn.length} junk` : ''}
          </div>
        </>
      )}
    </div>
  );
}

/* ==========================================================================
   SETTLE UP
   ========================================================================== */

/* ==========================================================================
   HOLE FEED
   Eighteen holes across a stack of games plus junk is a few hundred lines.
   Group it by hole, lead with the money that moved, open on demand.
   ========================================================================== */

function HoleFeed({ round, ledger }) {
  const n = round.players.length;
  const all = [...ledger.log, ...ledger.junkLog];
  const running = all.filter(l => l.live);
  const settled = all.filter(l => !l.live);

  const tags = ['all', ...round.games, ...(round.junkOn?.length ? ['junk'] : [])];
  const [tag, setTag] = useState('all');
  const keep = (l) => tag === 'all' || (tag === 'junk' ? l.junk : l.game === tag && !l.junk);

  const byHole = {};
  settled.filter(keep).forEach(l => { (byHole[l.h] = byHole[l.h] || []).push(l); });
  const holes = Object.keys(byHole).map(Number).sort((a, b) => b - a);

  const [open, setOpen] = useState(null);
  const openHole = open ?? holes[0];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', margin: '24px 0 9px' }}>
        <Eyebrow>hole by hole</Eyebrow>
        <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted }}>tap a hole to open it</span>
      </div>

      {tags.length > 2 && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 10, overflowX: 'auto', paddingBottom: 3 }}>
          {tags.map(t => (
            <Btn key={t} active={tag === t} onClick={() => setTag(t)} style={{ fontSize: 10.5, padding: '7px 10px', whiteSpace: 'nowrap' }}>
              {t === 'all' ? 'Everything' : t === 'junk' ? 'Junk' : gameName(t, n)}
            </Btn>
          ))}
        </div>
      )}

      {!!running.length && (
        <div style={{ background: C.card2, borderRadius: 11, padding: '10px 12px', marginBottom: 10 }}>
          <Eyebrow style={{ color: C.ink, marginBottom: 5 }}>still running</Eyebrow>
          {running.map((l, i) => (
            <div key={i} style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.5 }}>{l.text}</div>
          ))}
        </div>
      )}

      {!holes.length && (
        <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, padding: '14px 0' }}>
          Nothing settled here yet.
        </div>
      )}

      {holes.map(h => {
        const lines = byHole[h];
        const swing = zero(round);
        lines.forEach(l => addInto(swing, l.m || {}));
        const ranked = round.players.map(p => ({ p, v: r2(swing[p.id] || 0) })).sort((a, b) => b.v - a.v);
        const top = ranked[0], bot = ranked[ranked.length - 1];
        const isOpen = openHole === h;
        return (
          <div key={h} style={{ background: C.card, borderRadius: 11, marginBottom: 6, overflow: 'hidden' }}>
            <div onClick={() => setOpen(isOpen ? -1 : h)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', cursor: 'pointer' }}>
              <span style={{ fontFamily: F_MONO, fontWeight: 700, fontSize: 15, color: C.chalk, minWidth: 22 }}>{h + 1}</span>
              <span style={{ fontFamily: F_MONO, fontSize: 9.5, color: C.muted, minWidth: 44 }}>
                {lines.length} line{lines.length === 1 ? '' : 's'}
              </span>
              {top && top.v > 0 && (
                <span style={{ fontFamily: F_MONO, fontSize: 12, fontWeight: 700, color: C.up }}>{short(top.p.name)} {money(top.v)}</span>
              )}
              {bot && bot.v < 0 && (
                <span style={{ fontFamily: F_MONO, fontSize: 12, fontWeight: 700, color: C.down }}>{short(bot.p.name)} {money(bot.v)}</span>
              )}
              <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 11, color: C.muted }}>{isOpen ? '▴' : '▾'}</span>
            </div>
            {isOpen && (
              <div style={{ padding: '0 13px 12px' }}>
                {lines.map((l, i) => (
                  <div key={i} style={{ display: 'flex', gap: 9, padding: '6px 0', borderTop: `1px solid ${C.line}` }}>
                    <span style={{ fontFamily: F_MONO, fontSize: 9, color: C.muted, minWidth: 46, paddingTop: 2, textTransform: 'uppercase' }}>
                      {l.junk ? 'junk' : gameName(l.game, n).slice(0, 7)}
                    </span>
                    <span style={{ fontFamily: F_DISP, fontSize: 12.5, color: l.junk ? C.ink : C.chalk, lineHeight: 1.45 }}>{l.text}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 9, borderTop: `1px solid ${C.line}`, marginTop: 4 }}>
                  {ranked.filter(r => r.v !== 0).map(r => (
                    <span key={r.p.id} style={{ fontFamily: F_MONO, fontSize: 11, color: r.v > 0 ? C.up : C.down }}>
                      {short(r.p.name)} {money(r.v)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* Who is actually out there posting. With two foursomes on the course you
   cannot see the other group's scores, so you need to know somebody has it. */
function GroupStatus({ round, coverage, meIdx }) {
  const gs = round.groups || [];
  const [copied, setCopied] = useState(false);
  if (gs.length < 2) return null;

  const fresh = (i) => i === meIdx || (coverage[i]?.on && Date.now() - (coverage[i].at || 0) < 20 * 60 * 1000);
  const missing = gs.map((_, i) => i).filter(i => !fresh(i));

  return (
    <div style={{
      background: missing.length ? C.card : C.card2, borderRadius: 12, padding: '12px 13px', marginBottom: 12,
      border: `1px solid ${missing.length ? C.down : 'transparent'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
        <Eyebrow style={{ color: missing.length ? C.down : C.ink }}>
          {missing.length ? `${missing.length} group${missing.length > 1 ? 's' : ''} not posting` : 'all groups posting'}
        </Eyebrow>
        {round.code && (
          <Btn onClick={() => { try { navigator.clipboard.writeText(round.code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); } }}
            style={{ marginLeft: 'auto', fontSize: 10.5, padding: '6px 10px', fontFamily: F_MONO, letterSpacing: '0.1em' }}>
            {copied ? 'Copied' : round.code}
          </Btn>
        )}
      </div>

      {gs.map((g, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0' }}>
          <span style={{
            width: 7, height: 7, borderRadius: 7, marginTop: 5, flex: '0 0 7px',
            background: fresh(i) ? C.up : C.down,
          }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 13, color: C.chalk }}>
              Group {i + 1}{i === meIdx ? ' · you' : ''}
            </div>
            <div style={{ fontFamily: F_MONO, fontSize: 9.5, color: C.muted, lineHeight: 1.5 }}>
              {g.map(id => short(nameOf(round, id))).join(', ')}
            </div>
          </div>
          <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9, color: fresh(i) ? C.up : C.down, textTransform: 'uppercase', letterSpacing: '0.08em', paddingTop: 3 }}>
            {i === meIdx ? 'yours' : fresh(i) ? (coverage[i]?.at ? ago(coverage[i].at) : 'on') : 'waiting'}
          </span>
        </div>
      ))}

      {!!missing.length && (
        <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, lineHeight: 1.55, marginTop: 8 }}>
          Send the code to one man in {missing.length > 1 ? 'each of those groups' : `group ${missing[0] + 1}`}. He taps
          Join with a code, picks his group, and posts their scores. Nothing settles for a hole until every group is in.
        </div>
      )}
    </div>
  );
}

function SettleUp({ round, ledger }) {
  const [mode, setMode] = useState('direct');
  const loser = [...round.players].sort((a, b) => (ledger.money[a.id] || 0) - (ledger.money[b.id] || 0))[0];
  const [banker, setBanker] = useState(loser.id);
  const list = mode === 'direct' ? directTransfers(ledger.money, round.players) : bankerTransfers(ledger.money, round.players, banker);

  return (
    <div style={{ marginTop: 24 }}>
      <Eyebrow style={{ marginBottom: 9 }}>settle up</Eyebrow>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <Btn active={mode === 'direct'} onClick={() => setMode('direct')} style={{ flex: 1, fontSize: 11.5 }}>Fewest handoffs</Btn>
        <Btn active={mode === 'banker'} onClick={() => setMode('banker')} style={{ flex: 1, fontSize: 11.5 }}>One banker</Btn>
      </div>
      {mode === 'banker' && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {round.players.map(p => (
            <Btn key={p.id} active={banker === p.id} onClick={() => setBanker(p.id)} style={{ fontSize: 11, padding: '7px 9px' }}>{short(p.name)}</Btn>
          ))}
        </div>
      )}
      {!list.length ? (
        <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, padding: '12px 0' }}>Everybody is square. Nobody owes anybody.</div>
      ) : list.map((t, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', background: C.card, borderRadius: 10, marginBottom: 6 }}>
          <span style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.down }}>{nameOf(round, t.from)}</span>
          <span style={{ fontFamily: F_MONO, fontSize: 12, color: C.muted }}>pays</span>
          <span style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.up }}>{nameOf(round, t.to)}</span>
          <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: 16, color: C.chalk }}>{money(t.amt)}</span>
        </div>
      ))}
      <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
        {mode === 'direct'
          ? `${list.length} handoff${list.length === 1 ? '' : 's'} and everybody is square.`
          : `${nameOf(round, banker)} collects from the losers and pays out the winners.`}
      </div>
    </div>
  );
}

/* ==========================================================================
   PLAY
   ========================================================================== */

const stepBtn = { width: 38, height: 44, borderRadius: 10, border: `1px solid ${C.line}`, background: 'transparent', color: C.chalk, fontFamily: F_MONO, fontSize: 19, cursor: 'pointer', lineHeight: 1, flex: '0 0 38px' };
const navBtn = { width: 42, height: 42, borderRadius: 21, border: `1px solid ${C.line}`, background: 'transparent', color: C.chalk, fontSize: 12, cursor: 'pointer' };
const cell = { padding: '5px 3px', textAlign: 'center', minWidth: 20 };
const panel = { background: C.card, borderRadius: 12, padding: 12, marginBottom: 10 };

function PressSheet({ round, setRound, h, onClose }) {
  const opts = round.games.filter(k => k === 'nassau' || k === 'roundrobin');
  const [game, setGame] = useState(opts[0]);
  const [stake, setStake] = useState(String(round.stakes[opts[0]]));
  const n = round.players.length;

  const seg = rrSegOf(h);
  const runsTo = game === 'roundrobin'
    ? Math.min(seg * RR_SEG + RR_SEG - 1, round.holes - 1)
    : (h <= 8 ? Math.min(8, round.holes - 1) : round.holes - 1);
  const sides = game === 'roundrobin' ? rrTeams(round, seg) : sidesOf(round);
  const down = diffFor(round, sides[0], sides[1], game === 'roundrobin' ? seg * RR_SEG : (h <= 8 ? 0 : 9), h);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(6,14,10,.82)', zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.felt, borderTop: `1px solid ${C.line}`, borderRadius: '18px 18px 0 0',
        padding: '22px 18px 26px', width: '100%', maxWidth: 520,
      }}>
        <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 22, color: C.chalk, letterSpacing: '-0.02em' }}>New press</div>
        <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 16, lineHeight: 1.5 }}>
          A fresh bet that starts on this hole and runs to the end of the current match.
        </div>

        {opts.length > 1 && (
          <>
            <Eyebrow style={{ marginBottom: 7 }}>press which bet</Eyebrow>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {opts.map(k => (
                <Btn key={k} active={game === k} onClick={() => { setGame(k); setStake(String(round.stakes[k])); }} style={{ flex: 1, fontSize: 12 }}>
                  {gameName(k, n)}
                </Btn>
              ))}
            </div>
          </>
        )}

        <div style={{ padding: '12px 14px', background: C.card, borderRadius: 11, marginBottom: 14 }}>
          <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk }}>
            Holes {h + 1} through {runsTo + 1}
          </div>
          <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
            {down === 0
              ? 'All square right now, so this one starts from scratch.'
              : `${(down > 0 ? sides[0] : sides[1]).map(id => nameOf(round, id)).join(' + ')} are ${Math.abs(down)} up in the match you are pressing.`}
          </div>
        </div>

        <Eyebrow style={{ marginBottom: 7 }}>what is it worth</Eyebrow>
        <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
          {[0.5, 1, 2].map(mult => {
            const v = String(r2(round.stakes[game] * mult));
            return <Btn key={mult} active={stake === v} onClick={() => setStake(v)} style={{ flex: 1, fontSize: 11.5 }}>
              {mult === 1 ? 'Same bet' : mult === 2 ? 'Double' : 'Half'} {money(Number(v))}
            </Btn>;
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18 }}>
          <span style={{ fontFamily: F_MONO, fontSize: 18, color: C.muted }}>$</span>
          <input value={stake} onChange={e => setStake(e.target.value)} inputMode="decimal"
            style={{ ...inputStyle, width: 100, flex: '0 0 100px', fontFamily: F_MONO, fontSize: 17, textAlign: 'center' }} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={onClose} style={{ flex: '0 0 100px', padding: 15 }}>Cancel</Btn>
          <Btn kind="solid" onClick={() => {
            setRound(r => ({ ...r, presses: [...(r.presses || []), { game, s: h, e: runsTo, stake: Number(stake) || r.stakes[game] }] }));
            onClose();
          }} style={{ flex: 1, padding: 15, fontSize: 15 }}>Press it</Btn>
        </div>
      </div>
    </div>
  );
}

function Play({ round, setRound, onQuit, scope, groupNo, guest, coverage = [] }) {
  const [h, setH] = useState(() => { for (let i = 0; i < round.holes; i++) if (!holeComplete(round, i)) return i; return round.holes - 1; });
  const [tab, setTab] = useState('play');
  const [info, setInfo] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [pressing, setPressing] = useState(false);

  const ledger = useMemo(() => fullLedger(round), [round]);
  const n = round.players.length;
  const par = round.pars[h];
  const has = (k) => round.games.includes(k);
  const locked = !!round.locked;
  const mine = scope && scope.length ? round.players.filter(p => scope.includes(p.id)) : round.players;
  const scoped = !!(scope && scope.length);
  const missing = Array.from({ length: round.holes }, (_, i) => i).filter(i => !holeComplete(round, i));

  const setScore = (pid, v) => { if (locked) return; setRound(r => ({ ...r, scores: { ...r.scores, [h]: { ...(r.scores[h] || {}), [pid]: v } } })); };
  const setYard = (v) => setRound(r => { const y = [...(r.yards || [])]; y[h] = v; return { ...r, yards: y }; });

  const junkFor = (t) => round.junk?.[h]?.[t] || [];
  const toggleJunk = (type, pid) => { if (locked) return; setRound(r => {
    const cur = r.junk?.[h]?.[type] || [], def = JUNK[type];
    const next = cur.includes(pid) ? cur.filter(x => x !== pid) : (def.one ? [pid] : [...cur, pid]);
    return { ...r, junk: { ...r.junk, [h]: { ...(r.junk?.[h] || {}), [type]: next } } };
  }); };

  const wolfId = has('wolf') ? round.players[h % n].id : null;
  const call = round.wolf?.[h];
  const setCall = (v) => { if (locked) return; setRound(r => ({ ...r, wolf: { ...r.wolf, [h]: v } })); };
  const ham = round.hammer?.[h] || { mult: 1, conceded: null };
  const setHam = (patch) => { if (locked) return; setRound(r => ({ ...r, hammer: { ...r.hammer, [h]: { ...ham, ...patch } } })); };
  const bbb = round.bbb?.[h] || {};
  const setBbb = (k, pid) => { if (locked) return; setRound(r => ({ ...r, bbb: { ...r.bbb, [h]: { ...bbb, [k]: bbb[k] === pid ? null : pid } } })); };

  const holeVegas = teamsAt(round, h);
  const setHoleTeams = (i) => { if (locked) return; setRound(r => {
    const ids = r.players.map(p => p.id), pr = PAIRINGS[i];
    return { ...r, holeTeams: { ...r.holeTeams, [h]: [pr[0].map(x => ids[x]), pr[1].map(x => ids[x])] } };
  }); };
  const vegasPick = pairingIndex(round, holeVegas);

  const complete = holeComplete(round, h);
  const holeLog = ledger.log.filter(l => l.h === h && !l.live);
  const holeJunk = ledger.junkLog.filter(l => l.h === h && !l.live);

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', paddingBottom: 86 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '13px 16px 8px' }}>
        <div>
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 13, color: C.chalk }}>{APP_NAME}<span style={{ color: C.ink }}> {APP_SUB}</span></div>
          {round.code && <div style={{ fontFamily: F_MONO, fontWeight: 700, fontSize: 12, letterSpacing: '0.12em', color: C.ink, marginTop: 2 }}>#{round.code}</div>}
        </div>
        <div style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'right', lineHeight: 1.5 }}>
          {round.course ? <>{round.course}<br /></> : null}
          {round.games.map(k => `${gameName(k, n)} $${round.stakes[k]}`).join(' · ')}
          {round.junkOn?.length ? <><br />{round.junkOn.length} junk</> : null}
        </div>
        <button onClick={onQuit} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer', padding: 0 }}>×</button>
      </div>

      {locked && (
        <div style={{ margin: '4px 16px 10px', padding: '11px 13px', background: C.card2, border: `1px solid ${C.ball}`, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Eyebrow style={{ color: C.ink }}>round is final</Eyebrow>
            <div style={{ fontFamily: F_DISP, fontWeight: 600, fontSize: 12.5, color: C.muted, marginTop: 2 }}>Scores are locked. Nothing moves unless you reopen it.</div>
          </div>
          <Btn onClick={() => setRound(r => ({ ...r, locked: false }))} style={{ fontSize: 11 }}>Reopen</Btn>
        </div>
      )}

      {tab === 'play' && (
        <div style={{ padding: '0 16px' }}>
          {round.code && <GroupStatus round={round} coverage={coverage} meIdx={(groupNo || 1) - 1} />}

          {scoped && (
            <div style={{ background: C.card2, borderRadius: 11, padding: '10px 12px', marginBottom: 12 }}>
              <Eyebrow style={{ color: C.ink }}>you are keeping group {groupNo}</Eyebrow>
              <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, marginTop: 3, lineHeight: 1.5 }}>
                Post these {mine.length}. Everything else on the leaderboard comes from the other groups' phones.
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 3, marginBottom: 12, overflowX: 'auto', paddingBottom: 3 }}>
            {Array.from({ length: round.holes }).map((_, i) => (
              <button key={i} onClick={() => setH(i)} style={{
                minWidth: 21, height: 25, borderRadius: 5, cursor: 'pointer', flex: 1, padding: 0,
                border: `1px solid ${i === h ? C.ball : 'transparent'}`,
                background: i === h ? C.ball : holeComplete(round, i) ? C.card2 : C.card,
                color: i === h ? C.onBall : holeComplete(round, i) ? C.chalk : C.muted,
                fontFamily: F_MONO, fontSize: 10, fontWeight: 700,
              }}>{i + 1}</button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
            <button onClick={() => setH(x => Math.max(0, x - 1))} style={navBtn}>◀</button>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 36, color: C.chalk, lineHeight: 1, letterSpacing: '-0.03em' }}>{h + 1}</div>
              <Eyebrow style={{ marginTop: 3 }}>par {par} · index {round.si[h]}</Eyebrow>
            </div>
            <button onClick={() => setH(x => Math.min(round.holes - 1, x + 1))} style={navBtn}>▶</button>
          </div>

          {has('wolf') && (
            <div style={panel}>
              <Eyebrow style={{ color: C.ink, marginBottom: 8 }}>{nameOf(round, wolfId)} has the wolf</Eyebrow>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {round.players.filter(p => p.id !== wolfId).map(p => (
                  <Btn key={p.id} active={call === p.id} onClick={() => setCall(call === p.id ? null : p.id)} style={{ flex: 1, fontSize: 11.5, padding: '10px 4px', minWidth: 62 }}>{short(p.name)}</Btn>
                ))}
                <Btn active={call === 'lone'} onClick={() => setCall(call === 'lone' ? null : 'lone')} style={{ flex: 1, fontSize: 11.5, padding: '10px 4px', minWidth: 62 }}>Lone</Btn>
              </div>
            </div>
          )}

          {round.blindDraw && (() => {
            const solo = (round.teams || []).find(t => t.length === 1);
            if (!solo) return null;
            const ready = holeComplete(round, h);
            const drawn = ready ? blindPartner(round, h) : null;
            return (
              <div style={panel}>
                <Eyebrow style={{ color: C.ink, marginBottom: 6 }}>blind draw</Eyebrow>
                <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14.5, color: C.chalk, lineHeight: 1.4 }}>
                  {drawn
                    ? <>{nameOf(round, solo[0])} drew <span style={{ color: C.ink }}>{nameOf(round, drawn)}</span> on this hole</>
                    : `${nameOf(round, solo[0])} draws once every score is in`}
                </div>
                {drawn && (
                  <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 4 }}>
                    {nameOf(round, drawn)} still plays for his own team too.
                  </div>
                )}
              </div>
            );
          })()}

          {has('roundrobin') && (() => {
            const seg = rrSegOf(h), [A, B] = rrTeams(round, seg);
            const start = seg * RR_SEG + 1, end = Math.min(start + RR_SEG - 1, round.holes);
            return (
              <div style={panel}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
                  <Eyebrow style={{ color: C.ink }}>sixes {seg + 1}, holes {start} to {end}</Eyebrow>
                  <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted }}>
                    {h + 1 === end ? 'partners change next hole' : `${end - h - 1} to go`}
                  </span>
                </div>
                <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk }}>
                  {A.map(i => nameOf(round, i)).join(' + ')} <span style={{ color: C.muted, fontWeight: 400 }}>v</span> {B.map(i => nameOf(round, i)).join(' + ')}
                </div>
              </div>
            );
          })()}

          {round.partnerMode === 'rotate' && round.games.some(k => PARTNER_GAMES.includes(k)) && (
            <div style={panel}>
              <Eyebrow style={{ color: C.ink, marginBottom: 8 }}>partners this hole</Eyebrow>
              <div style={{ display: 'flex', gap: 5 }}>
                {PAIRINGS.map((p, i) => (
                  <Btn key={i} active={vegasPick === i} onClick={() => setHoleTeams(i)} style={{ flex: 1, fontSize: 10, padding: '10px 3px' }}>
                    {p.map(t => t.map(x => short(round.players[x].name).slice(0, 4)).join('/')).join(' v ')}
                  </Btn>
                ))}
              </div>
            </div>
          )}

          {has('yardage') && (
            <div style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <Eyebrow style={{ color: C.ink }}>this hole is worth</Eyebrow>
                <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: 19, color: C.chalk }}>
                  {money(r2((Number(round.yards?.[h]) || defYards(par)) * round.stakes.yardage))}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                <input value={round.yards?.[h] ?? ''} inputMode="numeric" disabled={locked}
                  onChange={e => setYard(e.target.value.replace(/\D/g, ''))}
                  placeholder={String(defYards(par))}
                  style={{ ...inputStyle, width: 78, flex: '0 0 78px', padding: '9px 4px', textAlign: 'center', fontFamily: F_MONO, fontSize: 15 }} />
                <span style={{ fontFamily: F_MONO, fontSize: 10.5, color: C.muted, lineHeight: 1.5 }}>
                  yards from the tee you played, at {money(round.stakes.yardage)} a yard.
                  {round.yardMode === 'split' ? ' Split among the losers.' : ' Each man pays it.'}
                </span>
              </div>
            </div>
          )}

          {has('hammer') && (
            <div style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
                <Eyebrow style={{ color: C.ink }}>hammer is worth</Eyebrow>
                <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: 19, color: (ham.mult || 1) >= 16 ? C.down : C.chalk }}>
                  {money(round.stakes.hammer * (ham.mult || 1))}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5, marginBottom: 7 }}>
                {[1, 2, 4, 8, 16, 32, 64].map(m => (
                  <Btn key={m} active={(ham.mult || 1) === m} tone={m >= 16 ? C.down : C.ball}
                    onClick={() => setHam({ mult: m })} style={{ fontSize: 12, padding: '10px 3px' }}>{m}x</Btn>
                ))}
                <Btn onClick={() => setHam({ mult: Math.min(64, (ham.mult || 1) * 2) })}
                  disabled={(ham.mult || 1) >= 64} style={{ fontSize: 11, padding: '10px 3px' }}>Throw</Btn>
              </div>
              <div style={{ display: 'flex', gap: 5 }}>
                {(teamsAt(round, h) || sidesOf(round)).map((s, i) => (
                  <Btn key={i} active={ham.conceded === (i ? 'B' : 'A')} tone={C.down}
                    onClick={() => setHam({ conceded: ham.conceded === (i ? 'B' : 'A') ? null : (i ? 'B' : 'A') })}
                    style={{ flex: 1, fontSize: 10.5, padding: '9px 3px' }}>
                    {s.map(id => short(nameOf(round, id))).join(' + ')} concede
                  </Btn>
                ))}
              </div>
              {(ham.mult || 1) >= 16 && (
                <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.down, marginTop: 8, lineHeight: 1.6 }}>
                  {ham.mult}x on one hole. That is {money(round.stakes.hammer * ham.mult)} riding on a single putt.
                </div>
              )}
            </div>
          )}

          {/* scores */}
          {mine.map(p => {
            const g = gross(round, p.id, h), str = strokesFor(round, p.id, h);
            const rel = g == null ? null : g - par;
            const col = rel == null ? C.muted : rel <= -2 ? C.ball : rel === -1 ? C.up : rel === 0 ? C.chalk : rel === 1 ? C.muted : C.down;
            const bt = has('roundrobin') ? rrTeams(round, rrSegOf(h)) : holeVegas;
            const ti = (bt || []).findIndex(t => t.includes(p.id));
            const solo = round.blindDraw && (round.teams || []).some(t => t.length === 1 && t[0] === p.id);
            const badge = has('wolf') && p.id === wolfId ? 'WOLF'
              : has('wolf') && call === p.id ? 'PARTNER'
              : solo ? 'BLIND DRAW'
              : ti >= 0 ? `TEAM ${ti + 1}` : null;
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '9px 11px',
                background: C.card, borderRadius: 12, marginBottom: 7,
                border: `1px solid ${badge === 'WOLF' ? C.ball : 'transparent'}`,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 15, color: C.chalk, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}<Dots n={str} />{ledger.snakeHolder === p.id && <span style={{ fontSize: 12, marginLeft: 4 }}>🐍</span>}
                  </div>
                  <div style={{ fontFamily: F_MONO, fontSize: 9.5, color: badge ? C.ink : C.muted, letterSpacing: '0.08em' }}>
                    {badge || (str > 0 ? `gets ${str} here` : 'no stroke here')}
                  </div>
                </div>
                <button onClick={() => setScore(p.id, g == null ? par : Math.max(1, g - 1))} disabled={locked} style={{ ...stepBtn, opacity: locked ? 0.3 : 1 }}>−</button>
                <button onClick={() => setScore(p.id, g == null ? par : null)} disabled={locked} style={{
                  width: 48, height: 44, flex: '0 0 48px', borderRadius: 10, border: `1px solid ${C.line}`,
                  background: g == null ? 'transparent' : C.card2, color: col,
                  fontFamily: F_MONO, fontWeight: 700, fontSize: 20, cursor: locked ? 'default' : 'pointer',
                }}>{g == null ? <span style={{ opacity: 0.3, fontSize: 14 }}>{par}</span> : g}</button>
                <button onClick={() => setScore(p.id, g == null ? par : g + 1)} disabled={locked} style={{ ...stepBtn, opacity: locked ? 0.3 : 1 }}>+</button>
              </div>
            );
          })}

          {has('bbb') && (
            <div style={{ ...panel, marginTop: 10 }}>
              {[['bingo', 'First on the green'], ['bango', 'Closest once all on'], ['bongo', 'First in the cup']].map(([k, lbl]) => (
                <div key={k} style={{ marginBottom: 9 }}>
                  <Eyebrow style={{ marginBottom: 6 }}>{lbl}</Eyebrow>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {round.players.map(p => <Btn key={p.id} active={bbb[k] === p.id} onClick={() => setBbb(k, p.id)} style={{ fontSize: 11, padding: '7px 9px' }}>{short(p.name)}</Btn>)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!round.junkOn?.length && (
            <div style={{ ...panel, marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
                <Eyebrow>junk on hole {h + 1}</Eyebrow>
                {ledger.snakeHolder && (
                  <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 10, color: C.snake }}>
                    🐍 {nameOf(round, ledger.snakeHolder)} · {money(ledger.snakeVal)}
                  </span>
                )}
              </div>
              {round.junkOn.map(type => {
                const d = JUNK[type], on = junkFor(type);
                const dim = d.par3 && par !== 3;
                const tone = d.hold ? C.snake : d.sign > 0 ? C.ball : C.down;
                return (
                  <div key={type} style={{ marginBottom: 10, opacity: dim ? 0.4 : 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <Eyebrow style={{ color: tone }}>{d.name}</Eyebrow>
                      <span style={{ fontFamily: F_MONO, fontSize: 9, color: C.muted }}>
                        {d.hold
                          ? `next pass ${money(snakeValue(round, ledger.snakePasses + 1))}`
                          : round.junkEscalate
                            ? `next one ${money(r2(junkLadder(round, Number(round.junkValues?.[type] ?? round.junkValue) || 1, (ledger.junkSeen?.[type] || 0) + 1)))}`
                            : money(round.junkValues?.[type] ?? round.junkValue)}
                        {dim ? ' · par 3s only' : ''}
                      </span>
                      <button onClick={() => setInfo(info === type ? null : type)} style={{
                        width: 17, height: 17, borderRadius: 9, border: `1px solid ${C.line}`, background: 'none',
                        color: C.muted, fontFamily: F_MONO, fontSize: 9, cursor: 'pointer', padding: 0, lineHeight: 1,
                      }}>i</button>
                    </div>
                    {info === type && <div style={{ fontFamily: F_DISP, fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 7 }}>{d.info}</div>}
                    {d.auto ? (
                      <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
                        {(() => {
                          const hits = mine.filter(p => {
                            const sc = round.useNet ? net(round, p.id, h) : gross(round, p.id, h);
                            return sc != null && round.pars[h] - sc >= 1;
                          });
                          return hits.length
                            ? `${hits.map(p => p.name).join(', ')} cashed on this hole.`
                            : 'Scored off the card. Nothing to tap.';
                        })()}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {mine.map(p => (
                          <Btn key={p.id} active={on.includes(p.id)} tone={tone} disabled={locked} onClick={() => toggleJunk(type, p.id)} style={{ fontSize: 11, padding: '7px 9px' }}>{short(p.name)}</Btn>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {round.games.some(k => k === 'nassau' || k === 'roundrobin') && (
            <div style={{ ...panel, marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
                <Eyebrow>presses</Eyebrow>
                <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted }}>
                  {(round.presses || []).length || 'none'} on the board
                </span>
              </div>
              {(round.presses || []).map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: C.card2, borderRadius: 9, marginBottom: 5 }}>
                  <span style={{ fontFamily: F_MONO, fontSize: 10.5, color: C.muted, textTransform: 'uppercase' }}>{gameName(p.game, n).slice(0, 8)}</span>
                  <span style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 13, color: C.chalk }}>
                    from {p.s + 1} through {p.e + 1}
                  </span>
                  <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: 13, color: C.ink }}>{money(p.stake)}</span>
                  {!locked && (
                    <button onClick={() => setRound(r => ({ ...r, presses: r.presses.filter((_, x) => x !== i) }))}
                      style={{ background: 'none', border: 'none', color: C.muted, fontSize: 15, cursor: 'pointer', padding: '0 2px' }}>×</button>
                  )}
                </div>
              ))}
              {!locked && (
                <Btn onClick={() => setPressing(true)} style={{ width: '100%', marginTop: 4, borderColor: C.ball, color: C.ink }}>
                  Add a press from hole {h + 1}
                </Btn>
              )}
            </div>
          )}

          <div style={{ marginTop: 14, padding: '11px 13px', background: C.card2, borderRadius: 12 }}>
            <Eyebrow style={{ marginBottom: 6 }}>what happened</Eyebrow>
            {!complete && !holeLog.length && (() => {
              const gs = round.groups || [];
              const behind = gs.map((g, i) => ({ i, g })).filter(({ g }) => g.some(id => gross(round, id, h) == null));
              const others = behind.filter(({ i }) => i !== (groupNo || 1) - 1);
              return (
                <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                  {gs.length > 1 && others.length && !behind.some(({ i }) => i === (groupNo || 1) - 1)
                    ? `Your four are in. Waiting on group ${others.map(({ i }) => i + 1).join(' and ')}.`
                    : 'Post every score to settle this hole'}
                </div>
              );
            })()}
            {holeLog.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <span style={{ fontFamily: F_MONO, fontSize: 9, color: C.muted, minWidth: 52, paddingTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {gameName(l.game, n).slice(0, 7)}
                </span>
                <span style={{ fontFamily: F_DISP, fontWeight: 600, fontSize: 12.5, color: C.chalk, lineHeight: 1.45 }}>{l.text}</span>
              </div>
            ))}
            {holeJunk.map((l, i) => (
              <div key={i} style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.ink, marginTop: 3 }}>{l.text}</div>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <Eyebrow style={{ marginBottom: 8 }}>where everybody stands</Eyebrow>
            <Standings round={round} ledger={ledger} compact />
            {ledger.extra && <div style={{ fontFamily: F_MONO, fontSize: 11, color: C.ink, marginTop: 5 }}>{ledger.extra}</div>}
          </div>
        </div>
      )}

      {tab === 'money' && (
        <div style={{ padding: '4px 16px' }}>
          {round.code && <CodeCard code={round.code} />}
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 25, color: C.chalk, letterSpacing: '-0.02em' }}>Leaderboard</div>
          <Eyebrow style={{ marginBottom: 16, marginTop: 3 }}>through {playedHoles(round).length} hole{playedHoles(round).length === 1 ? '' : 's'}</Eyebrow>
          <Standings round={round} ledger={ledger} />

          <SettleUp round={round} ledger={ledger} />

          {(round.games.length > 1 || round.junkOn?.length) && (
            <>
              <Eyebrow style={{ margin: '24px 0 8px' }}>where the money came from</Eyebrow>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: F_MONO, fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ ...cell, textAlign: 'left', color: C.muted }} />
                      {round.games.map(k => <th key={k} style={{ ...cell, color: C.muted, minWidth: 52 }}>{gameName(k, n).slice(0, 6)}</th>)}
                      {!!round.junkOn?.length && <th style={{ ...cell, color: C.ink, minWidth: 46 }}>junk</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {round.players.map(p => (
                      <tr key={p.id}>
                        <td style={{ ...cell, textAlign: 'left', fontFamily: F_DISP, fontWeight: 700, color: C.chalk, paddingRight: 8 }}>{short(p.name)}</td>
                        {round.games.map(k => {
                          const v = ledger.byGame[k].money[p.id] || 0;
                          return <td key={k} style={{ ...cell, color: v > 0 ? C.up : v < 0 ? C.down : C.muted }}>{v === 0 ? '—' : money(v)}</td>;
                        })}
                        {!!round.junkOn?.length && (() => {
                          const v = ledger.junk.money[p.id] || 0;
                          return <td style={{ ...cell, color: v > 0 ? C.up : v < 0 ? C.down : C.muted }}>{v === 0 ? '—' : money(v)}</td>;
                        })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <HoleFeed round={round} ledger={ledger} />

          {!locked && !guest && (
            <Btn kind="solid" onClick={() => setConfirming(true)} style={{ width: '100%', padding: 16, fontSize: 15, marginTop: 26 }}>
              Finish the round
            </Btn>
          )}
          <div style={{ height: 10 }} />
        </div>
      )}

      {pressing && <PressSheet round={round} setRound={setRound} h={h} onClose={() => setPressing(false)} />}

      {confirming && (
        <div onClick={() => setConfirming(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(6,14,10,.82)', zIndex: 50,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: C.felt, borderTop: `1px solid ${C.line}`, borderRadius: '18px 18px 0 0',
            padding: '22px 18px 26px', width: '100%', maxWidth: 520, maxHeight: '86vh', overflowY: 'auto',
          }}>
            <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 22, color: C.chalk, letterSpacing: '-0.02em' }}>Lock in the money?</div>
            <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 16, lineHeight: 1.5 }}>
              Check it over with the group before anybody pays. You can reopen it if something is wrong.
            </div>

            {!!missing.length && (
              <div style={{ padding: '11px 13px', background: C.card, border: `1px solid ${C.down}`, borderRadius: 11, marginBottom: 14 }}>
                <Eyebrow style={{ color: C.down }}>{missing.length} hole{missing.length === 1 ? '' : 's'} not posted</Eyebrow>
                <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, marginTop: 4, lineHeight: 1.5 }}>
                  Hole{missing.length === 1 ? '' : 's'} {missing.map(i => i + 1).join(', ')} {missing.length === 1 ? 'is' : 'are'} missing a score, so {missing.length === 1 ? 'it does' : 'they do'} not count toward anything.
                </div>
              </div>
            )}

            {round.games.includes('wolf') && (() => {
              const nocall = playedHoles(round).filter(i => !round.wolf?.[i]);
              return nocall.length ? (
                <div style={{ padding: '11px 13px', background: C.card, border: `1px solid ${C.down}`, borderRadius: 11, marginBottom: 14 }}>
                  <Eyebrow style={{ color: C.down }}>wolf call missing</Eyebrow>
                  <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.chalk, marginTop: 4 }}>
                    No partner or lone call on hole{nocall.length === 1 ? '' : 's'} {nocall.map(i => i + 1).join(', ')}.
                  </div>
                </div>
              ) : null;
            })()}

            {ledger.snakeHolder && (
              <div style={{ padding: '11px 13px', background: C.card, border: `1px solid ${C.snake}`, borderRadius: 11, marginBottom: 14 }}>
                <Eyebrow style={{ color: C.snake }}>the snake</Eyebrow>
                <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.chalk, marginTop: 4 }}>
                  {nameOf(round, ledger.snakeHolder)} is holding it after {ledger.snakePasses} pass{ledger.snakePasses === 1 ? '' : 'es'}. He pays each man {money(ledger.snakeVal)}.
                </div>
              </div>
            )}

            <Eyebrow style={{ marginBottom: 8 }}>final</Eyebrow>
            <Standings round={round} ledger={ledger} />

            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <Btn onClick={() => setConfirming(false)} style={{ flex: '0 0 110px', padding: 15 }}>Keep playing</Btn>
              <Btn kind="solid" onClick={() => { setRound(r => ({ ...r, locked: true, finishedAt: Date.now() })); setConfirming(false); }}
                style={{ flex: 1, padding: 15, fontSize: 15 }}>Lock it in</Btn>
            </div>
          </div>
        </div>
      )}

      {tab === 'card' && (
        <div style={{ padding: '4px 10px' }}>
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 25, color: C.chalk, marginBottom: 12, letterSpacing: '-0.02em', paddingLeft: 6 }}>Card</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: F_MONO, fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ ...cell, position: 'sticky', left: 0, background: C.felt }} />
                  {Array.from({ length: round.holes }).map((_, i) => <th key={i} style={{ ...cell, color: i === h ? C.ink : C.muted }}>{i + 1}</th>)}
                  <th style={{ ...cell, color: C.chalk }}>T</th>
                </tr>
                <tr>
                  <td style={{ ...cell, textAlign: 'left', color: C.muted, position: 'sticky', left: 0, background: C.felt }}>par</td>
                  {round.pars.map((p, i) => <td key={i} style={{ ...cell, color: C.muted }}>{p}</td>)}
                  <td style={{ ...cell, color: C.muted }}>{round.pars.reduce((a, b) => a + b, 0)}</td>
                </tr>
              </thead>
              <tbody>
                {round.players.map(p => {
                  const tot = Array.from({ length: round.holes }).reduce((s, _, i) => s + (gross(round, p.id, i) || 0), 0);
                  return (
                    <tr key={p.id}>
                      <td style={{ ...cell, textAlign: 'left', color: C.chalk, fontFamily: F_DISP, fontWeight: 700, position: 'sticky', left: 0, background: C.felt, paddingRight: 7 }}>{short(p.name)}</td>
                      {Array.from({ length: round.holes }).map((_, i) => {
                        const s = gross(round, p.id, i);
                        const rel = s == null ? null : s - round.pars[i];
                        const st = strokesFor(round, p.id, i);
                        return (
                          <td key={i} style={{
                            ...cell, background: i === h ? C.card : 'transparent', position: 'relative',
                            color: rel == null ? C.line : rel <= -1 ? C.up : rel === 0 ? C.chalk : rel === 1 ? C.muted : C.down,
                          }}>
                            {st > 0 && (
                              <span style={{ position: 'absolute', top: 2, right: 2, display: 'flex', gap: 1 }}>
                                {Array.from({ length: Math.min(st, 2) }).map((_, k) => (
                                  <span key={k} style={{ width: 3, height: 3, borderRadius: 3, background: C.ball, display: 'block' }} />
                                ))}
                              </span>
                            )}
                            {s ?? '·'}
                          </td>
                        );
                      })}
                      <td style={{ ...cell, color: C.chalk, fontWeight: 700 }}>{tot || '·'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 12, paddingLeft: 6, lineHeight: 1.6 }}>
            Gross scores, dots mark strokes. Bets settle on {round.useNet ? 'net' : 'gross'}.
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', background: C.card, borderTop: `1px solid ${C.line}`, padding: '8px 16px 14px' }}>
        <div style={{ display: 'flex', gap: 6, width: '100%', maxWidth: 490 }}>
          {[['play', 'Score'], ['money', 'Leaderboard'], ['card', 'Card']].map(([k, l]) => (
            <Btn key={k} active={tab === k} onClick={() => setTab(k)} style={{ flex: 1, padding: '12px 4px' }}>{l}</Btn>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   GROUP CODES
   The host publishes the round under a five digit code. Anyone in the group
   can punch in that code on their own phone and follow along read only.
   Published rounds sit in shared storage, so treat the code like a door key.
   ========================================================================== */

const gameKey = (code) => `ugb:game:${code}`;

/* Six characters out of 31, which is about 887 million codes. No 0/O and no
   1/I/L, because somebody is going to read this off a phone in the sun. */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;
const rollCode = () => Array.from({ length: CODE_LEN }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const cleanCode = (v) => (v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LEN);

async function freshCode() {
  if (!SHARING_ON) return null;   // solo mode: no code, nothing published
  for (let i = 0; i < 8; i++) {
    const c = rollCode();
    let taken = false;
    try { await storage.get(gameKey(c), true); taken = true; } catch { /* free */ }
    if (!taken) { try { await storage.get(tripKey(c), true); taken = true; } catch { /* free */ } }
    if (!taken) return c;
  }
  return rollCode();
}

/* Per hole data every scorer owns for their own foursome. Everything else is
   config the host owns. Split this way, two groups can post at the same time
   without stepping on each other. */
const CARD_FIELDS = ['scores', 'junk', 'wolf', 'hammer', 'bbb', 'holeTeams'];
const cardKey = (code, gi) => `${gameKey(code)}:c${gi}`;

const emptyCard = () => Object.fromEntries(CARD_FIELDS.map(k => [k, {}]));

/* Trim a card down to the players this device is responsible for. */
function scopeCard(round, ids) {
  const c = emptyCard();
  for (const h in round.scores || {}) {
    const kept = Object.entries(round.scores[h] || {}).filter(([pid]) => ids.includes(pid));
    if (kept.length) c.scores[h] = Object.fromEntries(kept);
  }
  for (const h in round.junk || {}) {
    for (const t in round.junk[h] || {}) {
      const kept = (round.junk[h][t] || []).filter(pid => ids.includes(pid));
      if (kept.length) { c.junk[h] = c.junk[h] || {}; c.junk[h][t] = kept; }
    }
  }
  ['wolf', 'hammer', 'bbb', 'holeTeams'].forEach(k => { c[k] = round[k] || {}; });
  return c;
}

function mergeRound(config, cards) {
  const out = { ...config, ...emptyCard() };
  for (const c of cards) {
    if (!c) continue;
    for (const h in c.scores || {}) out.scores[h] = { ...(out.scores[h] || {}), ...c.scores[h] };
    for (const h in c.junk || {}) {
      out.junk[h] = out.junk[h] || {};
      for (const t in c.junk[h]) out.junk[h][t] = [...new Set([...(out.junk[h][t] || []), ...c.junk[h][t]])];
    }
    ['wolf', 'hammer', 'bbb', 'holeTeams'].forEach(k => {
      for (const h in c[k] || {}) if (c[k][h] != null) out[k][h] = c[k][h];
    });
  }
  return out;
}

async function publishConfig(round) {
  if (!round?.code) return;
  const config = { ...round };
  CARD_FIELDS.forEach(k => delete config[k]);
  await storage.set(gameKey(round.code), JSON.stringify({ config, at: Date.now() }), true);
}

async function publishCard(code, gi, card) {
  if (!code) return;
  await storage.set(cardKey(code, gi), JSON.stringify({ card, at: Date.now() }), true);
}

async function pullConfig(code) {
  const r = await storage.get(gameKey(code), true);
  if (!r?.value) throw new Error('empty');
  const d = JSON.parse(r.value);
  return d.config ? d : { config: d.round, at: d.at };   // tolerate an older single blob
}

/* Just the timestamps, so we can tell who is actually out there posting. */
async function pullCardMeta(code, groupCount) {
  const out = [];
  for (let i = 0; i < Math.max(1, groupCount); i++) {
    try { const r = await storage.get(cardKey(code, i), true); out.push({ on: true, at: JSON.parse(r.value).at || 0 }); }
    catch { out.push({ on: false, at: 0 }); }
  }
  return out;
}

async function pullCards(code, groupCount) {
  const out = [];
  for (let i = 0; i < Math.max(1, groupCount); i++) {
    try { const r = await storage.get(cardKey(code, i), true); out.push(JSON.parse(r.value).card); }
    catch { out.push(null); }
  }
  return out;
}

/* Everything a follower or a second scorer needs, already stitched together. */
async function pull(code) {
  const { config, at } = await pullConfig(code);
  const cards = await pullCards(code, (config.groups || [[]]).length);
  return { round: mergeRound(config, cards), config, cards, at };
}

const publish = (round) => publishConfig(round);

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} hr ago`;
};

/* --- the code, shown big --- */
function CodeCard({ code, note }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ background: C.card2, border: `1px solid ${C.ball}`, borderRadius: 14, padding: '16px 16px 14px', marginBottom: 16 }}>
      <Eyebrow style={{ color: C.ink }}>group code</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
        <span style={{ fontFamily: F_MONO, fontWeight: 700, fontSize: 32, letterSpacing: '0.14em', color: C.chalk, lineHeight: 1 }}>{code}</span>
        <Btn onClick={() => {
          try { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
        }} style={{ marginLeft: 'auto', fontSize: 11 }}>{copied ? 'Copied' : 'Copy'}</Btn>
      </div>
      <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, marginTop: 9, lineHeight: 1.5 }}>
        {note || 'Text this to the group. Anyone who taps Join with a code and enters it can watch the leaderboard from their own phone.'}
      </div>
    </div>
  );
}

/* --- landing --- */
const SHARE_STATUS = {
  auth: 'Shared board: key or permissions rejected. Recheck the anon key and that you ran the setup SQL.',
  table: 'Shared board: the "kv" table was not found. Run the setup SQL in Supabase.',
  http: 'Shared board: the database returned an error. Check the setup.',
  network: 'Shared board: cannot reach the database. Check the Supabase URL, or your connection.',
};
function Home({ onNew, onTrip, onJoin, resume, tripResume, theme, setTheme }) {
  const [conn, setConn] = useState(null);
  useEffect(() => { if (SHARING_ON) remote.ping().then(setConn).catch(() => setConn({ ok: false, reason: 'network' })); }, []);
  return (
    <div style={{ padding: '52px 18px 40px', maxWidth: 520, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 34 }}>
        <div>
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 40, letterSpacing: '-0.035em', color: C.chalk, lineHeight: 0.92 }}>{APP_NAME}</div>
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 40, letterSpacing: '-0.035em', color: C.ink, lineHeight: 0.92 }}>{APP_SUB}</div>
          <Eyebrow style={{ marginTop: 12 }}>settle it before the parking lot</Eyebrow>
        </div>
        <button onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
          aria-label={theme === 'day' ? 'switch to the night palette' : 'switch to the day palette'}
          style={{
            marginLeft: 'auto', marginTop: 4, width: 40, height: 40, borderRadius: 20, cursor: 'pointer',
            border: `1px solid ${C.line}`, background: C.card, fontSize: 15, lineHeight: 1, padding: 0,
          }}>{theme === 'day' ? '☾' : '☀'}</button>
      </div>

      {resume && (
        <div onClick={resume.go} style={{ padding: 15, background: C.card2, border: `1px solid ${C.ball}`, borderRadius: 13, marginBottom: 14, cursor: 'pointer' }}>
          <Eyebrow style={{ color: C.ink }}>round in progress</Eyebrow>
          <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk, marginTop: 4, lineHeight: 1.4 }}>{resume.label}</div>
        </div>
      )}

      {tripResume && (
        <div onClick={tripResume.go} style={{ padding: 15, background: C.card2, border: `1px solid ${C.ball}`, borderRadius: 13, marginBottom: 14, cursor: 'pointer' }}>
          <Eyebrow style={{ color: C.ink }}>trip in progress</Eyebrow>
          <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 14, color: C.chalk, marginTop: 4, lineHeight: 1.4 }}>{tripResume.label}</div>
        </div>
      )}

      <Btn onClick={onNew} style={{ width: '100%', padding: '20px', fontSize: 16, marginBottom: 10 }}>Start a round</Btn>
      <Btn onClick={onTrip} style={{ width: '100%', padding: '20px', fontSize: 16, marginBottom: SHARING_ON ? 10 : 0 }}>Start a trip</Btn>
      {SHARING_ON && <Btn onClick={onJoin} style={{ width: '100%', padding: '20px', fontSize: 16 }}>Join with a code</Btn>}

      <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, marginTop: 18, lineHeight: 1.6 }}>
        {SHARING_ON
          ? 'One person keeps the card. Everybody else joins with the code and watches the money move. A trip is a stack of rounds on one leaderboard.'
          : 'One phone keeps the card for the group. A trip is a stack of rounds on one leaderboard.'}
      </div>

      {SHARING_ON && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 16 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 8, flex: '0 0 8px',
            background: conn == null ? C.muted : conn.ok ? C.up : C.down,
          }} />
          <span style={{ fontFamily: F_MONO, fontSize: 10, letterSpacing: '0.04em', color: conn && !conn.ok ? C.down : C.muted, lineHeight: 1.5 }}>
            {conn == null ? 'Checking the shared leaderboard…'
              : conn.ok ? 'Shared leaderboard connected. The group can follow with a code.'
              : (SHARE_STATUS[conn.reason] || 'Shared board: not reachable.')}
          </span>
        </div>
      )}
    </div>
  );
}

/* --- join --- */
function Join({ onFound, onBack }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ready = cleanCode(code).length === CODE_LEN;

  const [found, setFound] = useState(null);

  const go = async () => {
    const c = cleanCode(code);
    if (c.length !== CODE_LEN) { setErr(`A code is ${CODE_LEN} characters.`); return; }
    setBusy(true); setErr(null);
    try {
      const { kind, data } = await pullAny(c);
      const groups = kind === 'game' ? (data.round.groups || []) : [];
      if (kind === 'game' && groups.length > 1) setFound({ code: c, kind, data, groups });
      else onFound(c, kind, data, null);
    } catch { setErr(`Nothing running under ${c}. Check the code with whoever is keeping the card.`); }
    setBusy(false);
  };

  return (
    <div style={{ padding: '48px 18px 40px', maxWidth: 520, margin: '0 auto' }}>
      <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 26, color: C.chalk, letterSpacing: '-0.025em' }}>Join with a code</div>
      <div style={{ fontFamily: F_DISP, fontSize: 13.5, color: C.muted, marginTop: 6, marginBottom: 22, lineHeight: 1.5 }}>
        Six characters from whoever is keeping the card. Works for a single round or a whole trip.
      </div>

      {found && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 17, color: C.chalk, marginBottom: 4 }}>{found.data.round.course || 'Round'} is running</div>
          <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
            {found.groups.length} groups out there. Watch along, or keep the card for your own foursome.
          </div>
          <Btn onClick={() => onFound(found.code, 'game', found.data, null)} style={{ width: '100%', padding: 15, marginBottom: 12 }}>
            Just watching
          </Btn>
          <Eyebrow style={{ marginBottom: 8 }}>or keep score for</Eyebrow>
          {found.groups.map((g, gi) => (
            <Btn key={gi} onClick={() => onFound(found.code, 'game', found.data, gi)} style={{ width: '100%', padding: 13, marginBottom: 6, fontSize: 12.5 }}>
              Group {gi + 1} · {g.map(id => (found.data.round.players.find(p => p.id === id) || {}).name).filter(Boolean).join(', ')}
            </Btn>
          ))}
          <Btn onClick={() => { setFound(null); setCode(''); }} style={{ width: '100%', padding: 13, marginTop: 8 }}>Different code</Btn>
        </div>
      )}

      {!found && <><input value={code} inputMode="text" autoFocus
        onChange={e => { setCode(cleanCode(e.target.value)); setErr(null); }}
        placeholder="XXXXXX" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
        style={{ ...inputStyle, fontFamily: F_MONO, fontSize: 32, fontWeight: 700, letterSpacing: '0.18em', textAlign: 'center', padding: '18px 10px', marginBottom: 12 }} />

      {err && <div style={{ fontFamily: F_DISP, fontSize: 12.5, color: C.down, lineHeight: 1.5, marginBottom: 12 }}>{err}</div>}

      <Btn kind="solid" onClick={go} disabled={busy || !ready} style={{ width: '100%', padding: 17, fontSize: 15, marginBottom: 8 }}>
        {busy ? 'Looking...' : 'Find the game'}
      </Btn></>}
      <Btn onClick={onBack} style={{ width: '100%', padding: 15 }}>Back</Btn>
    </div>
  );
}

/* --- read only follower view --- */
/* A guest scorer. Owns exactly one group's card, polls for the rest. */
function ScoreKeeper({ code, gi, initial, onLeave }) {
  const [config, setConfig] = useState(initial.config);
  const [cards, setCards] = useState(initial.cards);
  const [stale, setStale] = useState(false);
  const [coverage, setCoverage] = useState([]);
  const dirty = useRef(false);

  /* claim the group straight away so the host can see somebody has it */
  useEffect(() => { publishCard(code, gi, initial.cards[gi] || emptyCard()).catch(() => {}); }, []); // eslint-disable-line

  const scope = (config.groups || [[]])[gi] || [];
  const round = useMemo(() => mergeRound(config, cards), [config, cards]);

  /* pull everybody else's cards, keep our own local copy authoritative */
  const refresh = async () => {
    try {
      const { config: cfg } = await pullConfig(code);
      const fresh = await pullCards(code, (cfg.groups || [[]]).length);
      setConfig(cfg);
      setCards(prev => fresh.map((c, i) => (i === gi ? (prev[i] || c) : c)));
      setCoverage(await pullCardMeta(code, (cfg.groups || [[]]).length));
      setStale(false);
    } catch { setStale(true); }
  };
  useEffect(() => { const t = setInterval(refresh, 12000); return () => clearInterval(t); }, [code, gi]); // eslint-disable-line

  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => { publishCard(code, gi, cards[gi] || emptyCard()).catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [cards, code, gi]);

  const setRound = (upd) => {
    dirty.current = true;
    setCards(prev => {
      const cur = mergeRound(config, prev);
      const next = typeof upd === 'function' ? upd(cur) : upd;
      const out = [...prev];
      out[gi] = scopeCard(next, scope);
      return out;
    });
  };

  return (
    <>
      {stale && (
        <div style={{ padding: '9px 16px', background: C.card2, fontFamily: F_MONO, fontSize: 10, color: C.down }}>
          Cannot reach the other groups. Your scores are saved and will sync.
        </div>
      )}
      <Play round={round} setRound={setRound} onQuit={onLeave} scope={scope} groupNo={gi + 1} guest coverage={coverage} />
    </>
  );
}

function Viewer({ code, initial, onLeave }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState('money');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try { setData(await pull(code)); setStale(false); }
    catch { setStale(true); }
    setBusy(false);
  };

  useEffect(() => {
    const t = setInterval(refresh, 12000);
    return () => clearInterval(t);
  }, [code]); // eslint-disable-line

  const round = data.round;
  const n = round.players.length;
  const ledger = useMemo(() => fullLedger(round), [round]);
  const done = playedHoles(round).length;

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', paddingBottom: 86 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '13px 16px 8px' }}>
        <div>
          <div style={{ fontFamily: F_MONO, fontWeight: 700, fontSize: 15, letterSpacing: '0.1em', color: C.ink }}>#{code}</div>
          <div style={{ fontFamily: F_MONO, fontSize: 9, color: C.muted, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 2 }}>watching</div>
        </div>
        <div style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'right', lineHeight: 1.5 }}>
          {round.course ? <>{round.course}<br /></> : null}
          {round.games.map(k => gameName(k, n)).join(' · ')}
        </div>
        <button onClick={onLeave} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer', padding: 0 }}>×</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 12px' }}>
        <span style={{ fontFamily: F_MONO, fontSize: 10, color: stale ? C.down : C.muted }}>
          {stale ? 'Could not reach the card' : `through ${done} hole${done === 1 ? '' : 's'} · updated ${ago(data.at)}`}
        </span>
        <Btn onClick={refresh} disabled={busy} style={{ marginLeft: 'auto', fontSize: 10.5, padding: '7px 11px' }}>{busy ? '...' : 'Refresh'}</Btn>
      </div>

      {round.locked && (
        <div style={{ margin: '0 16px 12px', padding: '11px 13px', background: C.card2, border: `1px solid ${C.ball}`, borderRadius: 12 }}>
          <Eyebrow style={{ color: C.ink }}>round is final</Eyebrow>
          <div style={{ fontFamily: F_DISP, fontWeight: 600, fontSize: 12.5, color: C.muted, marginTop: 2 }}>Cards are in. This is what everybody owes.</div>
        </div>
      )}

      {tab === 'money' && (
        <div style={{ padding: '0 16px' }}>
          <Standings round={round} ledger={ledger} />
          <SettleUp round={round} ledger={ledger} />
          <HoleFeed round={round} ledger={ledger} />
          <div style={{ height: 12 }} />
        </div>
      )}

      {tab === 'card' && (
        <div style={{ padding: '0 10px', overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: F_MONO, fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ ...cell, position: 'sticky', left: 0, background: C.felt }} />
                {round.pars.map((_, i) => <th key={i} style={{ ...cell, color: C.muted }}>{i + 1}</th>)}
                <th style={{ ...cell, color: C.chalk }}>T</th>
              </tr>
              <tr>
                <td style={{ ...cell, textAlign: 'left', color: C.muted, position: 'sticky', left: 0, background: C.felt }}>par</td>
                {round.pars.map((p, i) => <td key={i} style={{ ...cell, color: C.muted }}>{p}</td>)}
                <td style={{ ...cell, color: C.muted }}>{round.pars.reduce((a, b) => a + b, 0)}</td>
              </tr>
            </thead>
            <tbody>
              {round.players.map(p => {
                const tot = round.pars.reduce((s, _, i) => s + (gross(round, p.id, i) || 0), 0);
                return (
                  <tr key={p.id}>
                    <td style={{ ...cell, textAlign: 'left', color: C.chalk, fontFamily: F_DISP, fontWeight: 700, position: 'sticky', left: 0, background: C.felt, paddingRight: 7 }}>{short(p.name)}</td>
                    {round.pars.map((pr, i) => {
                      const sc = gross(round, p.id, i), rel = sc == null ? null : sc - pr;
                      return <td key={i} style={{ ...cell, color: rel == null ? C.line : rel <= -1 ? C.up : rel === 0 ? C.chalk : rel === 1 ? C.muted : C.down }}>{sc ?? '·'}</td>;
                    })}
                    <td style={{ ...cell, color: C.chalk, fontWeight: 700 }}>{tot || '·'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', background: C.card, borderTop: `1px solid ${C.line}`, padding: '8px 16px 14px' }}>
        <div style={{ display: 'flex', gap: 6, width: '100%', maxWidth: 490 }}>
          {[['money', 'Leaderboard'], ['card', 'Card']].map(([k, l]) => (
            <Btn key={k} active={tab === k} onClick={() => setTab(k)} style={{ flex: 1, padding: '12px 4px' }}>{l}</Btn>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   TRIPS
   A trip is a bag of rounds sharing one roster. Money carries across every
   round so the whole week lands on one leaderboard.
   ========================================================================== */

const tripKey = (code) => `ugb:trip:${code}`;

async function publishTrip(trip) {
  if (!trip?.code) return;
  await storage.set(tripKey(trip.code), JSON.stringify({ trip, at: Date.now() }), true);
}

/* A code can belong to a single round or a whole trip. Try both. */
async function pullAny(code) {
  try { const d = await pull(code); return { kind: 'game', data: d }; } catch { /* not a round */ }
  const r = await storage.get(tripKey(code), true);
  if (!r?.value) throw new Error('empty');
  return { kind: 'trip', data: JSON.parse(r.value) };
}

/* A round only lands on the trip board once it has been locked in. Live
   rounds still show their own numbers, they just do not move the total yet. */
function tripTotals(trip) {
  const money = Object.fromEntries(trip.roster.map(p => [p.id, 0]));
  const rounds = (trip.rounds || []).map(r => {
    const led = fullLedger(r.round);
    return {
      id: r.id, label: r.label, round: r.round, money: led.money,
      played: playedHoles(r.round).length, locked: !!r.round.locked,
    };
  });
  rounds.filter(r => r.locked).forEach(r => addInto(money, r.money));
  return {
    money, rounds,
    counted: rounds.filter(r => r.locked).length,
    live: rounds.filter(r => !r.locked && r.played).length,
    ledger: { money, points: null, snakeHolder: null },
  };
}

const rosterAs = (trip) => ({ players: trip.roster });

/* --- one row per round --- */
function RoundRow({ trip, r, onOpen }) {
  const best = [...trip.roster].filter(p => r.money[p.id] != null)
    .sort((a, b) => (r.money[b.id] || 0) - (r.money[a.id] || 0))[0];
  const v = best ? r.money[best.id] || 0 : 0;
  const names = r.round.players.map(p => p.name).join(', ');
  return (
    <div onClick={onOpen} style={{ padding: '12px 13px', background: C.card, borderRadius: 12, marginBottom: 7, cursor: onOpen ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: F_DISP, fontWeight: 800, fontSize: 15, color: C.chalk }}>{r.label}</span>
        <span style={{ fontFamily: F_MONO, fontSize: 9, letterSpacing: '0.1em', color: r.locked ? C.muted : C.ink, textTransform: 'uppercase' }}>
          {r.locked ? 'final' : r.played ? 'live' : 'not started'}
        </span>
        {v > 0 && (
          <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontWeight: 700, fontSize: 13, color: C.up }}>
            {best.name} {money(v)}
          </span>
        )}
      </div>
      <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
        {r.round.course ? `${r.round.course} · ` : ''}{r.round.games.map(k => gameName(k, r.round.players.length)).join(' · ')}
        <br />{r.played} of {r.round.holes} holes · {names}
      </div>
    </div>
  );
}

/* --- host trip hub --- */
function TripHub({ trip, onAddRound, onOpenRound, onLeave }) {
  const { money, rounds, ledger, counted, live } = useMemo(() => tripTotals(trip), [trip]);
  const shell = rosterAs(trip);

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 25, color: C.chalk, letterSpacing: '-0.025em', lineHeight: 1.05 }}>{trip.name}</div>
          <Eyebrow style={{ marginTop: 4 }}>{trip.roster.length} players · {rounds.length} round{rounds.length === 1 ? '' : 's'}{live ? ` · ${live} live` : ''}</Eyebrow>
        </div>
        <button onClick={onLeave} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer', padding: 0 }}>×</button>
      </div>

      {trip.code && <CodeCard code={trip.code} note="Text this to the group. Anyone who joins with it follows the whole trip, every round and the running total." />}

      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 9 }}>
        <Eyebrow>trip standings</Eyebrow>
        <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted }}>
          {counted} round{counted === 1 ? '' : 's'} counted
        </span>
      </div>
      {counted ? <Standings round={shell} ledger={ledger} /> : (
        <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, padding: '10px 0 4px', lineHeight: 1.5 }}>
          {rounds.length
            ? 'Nothing counted yet. A round joins the trip total when somebody locks it in on the leaderboard tab.'
            : 'No rounds yet. Add the first one and the money starts stacking up.'}
        </div>
      )}
      {!!live && (
        <div style={{ fontFamily: F_MONO, fontSize: 10, color: C.ink, marginTop: 8, lineHeight: 1.6 }}>
          {live} round{live === 1 ? ' is' : 's are'} still going. {live === 1 ? 'It joins' : 'They join'} the total once locked in.
        </div>
      )}

      <Btn kind="solid" onClick={onAddRound} style={{ width: '100%', padding: 17, fontSize: 15, marginTop: 16 }}>
        Add a round
      </Btn>

      {!!rounds.length && (
        <>
          <Eyebrow style={{ margin: '26px 0 9px' }}>the rounds</Eyebrow>
          {[...rounds].reverse().map(r => <RoundRow key={r.id} trip={trip} r={r} onOpen={() => onOpenRound(r.id)} />)}

          <Eyebrow style={{ margin: '26px 0 9px' }}>round by round</Eyebrow>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: F_MONO, fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ ...cell, textAlign: 'left', position: 'sticky', left: 0, background: C.felt }} />
                  {rounds.map((r, i) => (
                    <th key={r.id} style={{ ...cell, color: r.locked ? C.muted : C.ink, minWidth: 46 }}>
                      R{i + 1}{r.locked ? '' : '*'}
                    </th>
                  ))}
                  <th style={{ ...cell, color: C.ink, minWidth: 56 }}>total</th>
                </tr>
              </thead>
              <tbody>
                {[...trip.roster].sort((a, b) => (money[b.id] || 0) - (money[a.id] || 0)).map(p => (
                  <tr key={p.id}>
                    <td style={{ ...cell, textAlign: 'left', fontFamily: F_DISP, fontWeight: 700, color: C.chalk, position: 'sticky', left: 0, background: C.felt, paddingRight: 8 }}>{short(p.name)}</td>
                    {rounds.map(r => {
                      const inIt = r.round.players.some(x => x.id === p.id);
                      const v = r.money[p.id] || 0;
                      return <td key={r.id} style={{ ...cell, opacity: r.locked ? 1 : 0.45, color: !inIt ? C.line : v > 0 ? C.up : v < 0 ? C.down : C.muted }}>
                        {!inIt ? '·' : v === 0 ? '—' : money(v)}
                      </td>;
                    })}
                    <td style={{ ...cell, fontWeight: 700, color: (money[p.id] || 0) > 0 ? C.up : (money[p.id] || 0) < 0 ? C.down : C.muted }}>
                      {money(money[p.id] || 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontFamily: F_MONO, fontSize: 9.5, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
            A dot means he sat that one out. A star means the round is still live, so it is not in the total yet.
          </div>

          {!!counted && <SettleUp round={shell} ledger={ledger} />}
        </>
      )}
    </div>
  );
}

/* --- follower trip view --- */
function TripView({ code, initial, onLeave }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(null);

  const refresh = async () => {
    setBusy(true);
    try { const r = await storage.get(tripKey(code), true); setData(JSON.parse(r.value)); setStale(false); }
    catch { setStale(true); }
    setBusy(false);
  };
  useEffect(() => { const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [code]); // eslint-disable-line

  const trip = data.trip;
  const { money, rounds, ledger, counted, live } = useMemo(() => tripTotals(trip), [trip]);
  const shell = rosterAs(trip);
  const openRound = open != null ? rounds.find(r => r.id === open) : null;

  if (openRound) {
    const r = openRound.round, led = fullLedger(r), n = r.players.length;
    return (
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '16px 16px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <Btn onClick={() => setOpen(null)} style={{ fontSize: 11 }}>Back to trip</Btn>
          <span style={{ marginLeft: 'auto', fontFamily: F_MONO, fontSize: 9.5, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {openRound.label}
          </span>
        </div>
        <Standings round={r} ledger={led} />
        <HoleFeed round={r} ledger={led} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 24, color: C.chalk, letterSpacing: '-0.025em' }}>{trip.name}</div>
          <div style={{ fontFamily: F_MONO, fontWeight: 700, fontSize: 12, letterSpacing: '0.12em', color: C.ink, marginTop: 3 }}>#{code} · watching</div>
        </div>
        <button onClick={onLeave} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer', padding: 0 }}>×</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontFamily: F_MONO, fontSize: 10, color: stale ? C.down : C.muted }}>
          {stale ? 'Could not reach the trip' : `${counted} counted${live ? `, ${live} live` : ''} · updated ${ago(data.at)}`}
        </span>
        <Btn onClick={refresh} disabled={busy} style={{ marginLeft: 'auto', fontSize: 10.5, padding: '7px 11px' }}>{busy ? '...' : 'Refresh'}</Btn>
      </div>

      <Eyebrow style={{ marginBottom: 9 }}>trip standings</Eyebrow>
      {counted ? (
        <>
          <Standings round={shell} ledger={ledger} />
          <SettleUp round={shell} ledger={ledger} />
        </>
      ) : (
        <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
          Nothing counted yet. Rounds join the total once they are locked in. Tap a live round below to see how it is going.
        </div>
      )}

      <Eyebrow style={{ margin: '26px 0 9px' }}>the rounds</Eyebrow>
      {[...rounds].reverse().map(r => <RoundRow key={r.id} trip={trip} r={r} onOpen={() => setOpen(r.id)} />)}
      {!rounds.length && <div style={{ fontFamily: F_DISP, fontSize: 13, color: C.muted }}>Nobody has teed off yet.</div>}
    </div>
  );
}

/* --- trip setup --- */
function TripSetup({ onCreate, onBack }) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState(Array(4).fill(null).map(() => ({ name: '', hcp: '' })));
  const [busy, setBusy] = useState(false);
  const filled = rows.filter(r => r.name.trim());
  const ready = name.trim() && filled.length >= 2;

  const set = (i, k, v) => setRows(r => { const c = r.map(x => ({ ...x })); c[i][k] = v; return c; });

  const go = async () => {
    setBusy(true);
    let code = null;
    try { code = await freshCode(); } catch { /* offline, run it local */ }
    onCreate({
      code, name: name.trim(),
      roster: filled.map(r => ({ id: uid(), name: r.name.trim(), hcp: Number(r.hcp) || 0 })),
      rounds: [], createdAt: Date.now(),
    });
  };

  return (
    <div style={{ padding: '44px 18px 40px', maxWidth: 520, margin: '0 auto' }}>
      <div style={{ fontFamily: F_DISP, fontWeight: 900, fontSize: 26, color: C.chalk, letterSpacing: '-0.025em' }}>Start a trip</div>
      <div style={{ fontFamily: F_DISP, fontSize: 13.5, color: C.muted, marginTop: 6, marginBottom: 22, lineHeight: 1.5 }}>
        Set the roster once. Every round you add pulls from it, and the money stacks up across the whole trip.
      </div>

      <Eyebrow style={{ marginBottom: 8 }}>what are you calling it</Eyebrow>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Bandon 2026" style={{ ...inputStyle, marginBottom: 22 }} />

      <Eyebrow style={{ marginBottom: 8 }}>the roster</Eyebrow>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input value={r.name} onChange={e => set(i, 'name', e.target.value)} placeholder={`Player ${i + 1}`} style={inputStyle} />
          <input value={r.hcp} onChange={e => set(i, 'hcp', e.target.value)} placeholder="hcp" style={{ ...inputStyle, width: 70, flex: '0 0 70px', textAlign: 'center' }} />
        </div>
      ))}
      {rows.length < 24 && (
        <Btn onClick={() => setRows(r => [...r, { name: '', hcp: '' }])} style={{ width: '100%', marginBottom: 20 }}>+ add a player</Btn>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn onClick={onBack} style={{ flex: '0 0 88px' }}>Back</Btn>
        <Btn kind="solid" disabled={!ready || busy} onClick={go} style={{ flex: 1, padding: 16, fontSize: 15 }}>
          {busy ? 'Setting up...' : `Start the trip${filled.length ? ` with ${filled.length}` : ''}`}
        </Btn>
      </div>
    </div>
  );
}

/* ==========================================================================
   ROOT
   ========================================================================== */

export default function App() {
  const [theme, setTheme] = useState('day');
  applyTheme(theme);
  const [screen, setScreen] = useState('home');
  const [round, setRound] = useState(null);       // standalone round
  const [saved, setSaved] = useState(null);
  const [trip, setTrip] = useState(null);
  const [savedTrip, setSavedTrip] = useState(null);
  const [activeId, setActiveId] = useState(null); // which trip round is open
  const [coverage, setCoverage] = useState([]);
  const [view, setView] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const first = useRef(true), firstTrip = useRef(true);

  useEffect(() => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800;900&family=IBM+Plex+Mono:wght@400;600;700&display=swap';
    document.head.appendChild(l);
  }, []);

  useEffect(() => {
    (async () => {
      try { const r = await storage.get('ugb:round'); if (r?.value) setSaved(JSON.parse(r.value)); } catch {}
      try { const t = await storage.get('ugb:trip'); if (t?.value) setSavedTrip(JSON.parse(t.value)); } catch {}
      try { const th = await storage.get('ugb:theme'); if (th?.value) setTheme(th.value); } catch {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    (async () => {
      try {
        if (round) await storage.set('ugb:round', JSON.stringify(round));
        else await storage.delete('ugb:round');
      } catch {}
    })();
  }, [round]);

  useEffect(() => {
    if (!round?.code) return;
    const t = setTimeout(() => {
      publishConfig(round).catch(() => {});
      publishCard(round.code, 0, scopeCard(round, (round.groups || [[]])[0] || round.players.map(p => p.id))).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [round]);

  /* more than one group means other phones are posting too, so fold them in */
  useEffect(() => {
    const gs = (round?.groups || []).length;
    if (!round?.code || gs < 2) return;
    const sync = async () => {
      try {
        const cards = await pullCards(round.code, gs);
        setCoverage(await pullCardMeta(round.code, gs));
        setRound(r => {
          const mineIds = (r.groups || [[]])[0] || [];
          const merged = mergeRound(r, cards.map((c, i) => (i === 0 ? scopeCard(r, mineIds) : c)));
          return { ...r, ...Object.fromEntries(CARD_FIELDS.map(k => [k, merged[k]])) };
        });
      } catch { /* offline, keep playing */ }
    };
    const t = setInterval(sync, 12000);
    return () => clearInterval(t);
  }, [round?.code, (round?.groups || []).length]); // eslint-disable-line

  useEffect(() => {
    if (firstTrip.current) { firstTrip.current = false; return; }
    if (!trip) return;
    (async () => { try { await storage.set('ugb:trip', JSON.stringify(trip)); } catch {} })();
    const t = setTimeout(() => { publishTrip(trip).catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [trip]);

  /* the round currently open inside a trip */
  const tripRound = trip && activeId ? (trip.rounds.find(r => r.id === activeId) || {}).round : null;
  const setTripRound = (upd) => setTrip(t => ({
    ...t,
    rounds: t.rounds.map(r => r.id === activeId ? { ...r, round: typeof upd === 'function' ? upd(r.round) : upd } : r),
  }));

  const startRound = async (r) => {
    let code = null;
    try { code = await freshCode(); } catch {}
    const full = { ...r, code };
    setRound(full); setScreen('play');
    if (code) publish(full).catch(() => {});
  };

  const addTripRound = (r) => {
    const id = uid();
    const label = r.course || `Round ${(trip.rounds.length || 0) + 1}`;
    setTrip(t => ({ ...t, rounds: [...t.rounds, { id, label, round: { ...r, code: null }, at: Date.now() }] }));
    setActiveId(id); setScreen('tripplay');
  };

  const pickTheme = (t) => { setTheme(t); storage.set('ugb:theme', t).catch(() => {}); };

  const shell = (kids) => (
    <div style={{ minHeight: '100vh', background: C.felt, color: C.chalk, WebkitFontSmoothing: 'antialiased' }}>
      <style>{`
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${C.ball}; outline-offset: 2px; }
        input::placeholder { color: ${C.muted}; opacity: .55; }
        ::-webkit-scrollbar { height: 0; width: 0; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>
      {kids}
    </div>
  );

  if (!loaded) return shell(null);

  if (screen === 'join') return shell(
    <Join onBack={() => setScreen('home')} onFound={(code, kind, data, gi) => {
      setView({ code, kind, data, gi });
      setScreen(kind === 'trip' ? 'tripview' : gi != null ? 'keep' : 'view');
    }} />
  );
  if (screen === 'keep' && view) return shell(
    <ScoreKeeper code={view.code} gi={view.gi} initial={view.data} onLeave={() => { setView(null); setScreen('home'); }} />
  );
  if (screen === 'view' && view) return shell(
    <Viewer code={view.code} initial={view.data} onLeave={() => { setView(null); setScreen('home'); }} />
  );
  if (screen === 'tripview' && view) return shell(
    <TripView code={view.code} initial={view.data} onLeave={() => { setView(null); setScreen('home'); }} />
  );

  if (screen === 'tripsetup') return shell(
    <TripSetup onBack={() => setScreen('home')} onCreate={(t) => { setTrip(t); setScreen('trip'); publishTrip(t).catch(() => {}); }} />
  );

  if (screen === 'trip' && trip) return shell(
    <TripHub trip={trip}
      onAddRound={() => setScreen('tripadd')}
      onOpenRound={(id) => { setActiveId(id); setScreen('tripplay'); }}
      onLeave={() => { setSavedTrip(trip); setScreen('home'); }} />
  );

  if (screen === 'tripadd' && trip) return shell(
    <Setup roster={trip.roster} onStart={addTripRound} onBack={() => setScreen('trip')} />
  );

  if (screen === 'tripplay' && tripRound) return shell(
    <Play round={{ ...tripRound, code: trip.code }} setRound={setTripRound} onQuit={() => setScreen('trip')}
      scope={trip.code && (tripRound.groups || []).length > 1 ? tripRound.groups[0] : null} groupNo={1} coverage={coverage} />
  );

  if (screen === 'setup') return shell(<Setup onStart={startRound} onBack={() => setScreen('home')} />);

  if (screen === 'play' && round) return shell(
    <Play round={round} setRound={setRound} onQuit={() => { setSaved(round); setRound(null); setScreen('home'); }}
      scope={round.code && (round.groups || []).length > 1 ? round.groups[0] : null} groupNo={1} coverage={coverage} />
  );

  return shell(
    <Home
      theme={theme} setTheme={pickTheme}
      onNew={() => setScreen('setup')}
      onTrip={() => setScreen('tripsetup')}
      onJoin={() => setScreen('join')}
      resume={saved?.games ? {
        label: `${saved.games.map(k => gameName(k, saved.players.length)).join(' + ')} · ${saved.players.map(p => p.name).join(', ')}`,
        go: () => { setRound(saved); setScreen('play'); },
      } : null}
      tripResume={(trip || savedTrip)?.roster ? {
        label: `${(trip || savedTrip).name} · ${(trip || savedTrip).rounds.length} round${(trip || savedTrip).rounds.length === 1 ? '' : 's'}`,
        go: () => { if (!trip) setTrip(savedTrip); setScreen('trip'); },
      } : null}
    />
  );
}
