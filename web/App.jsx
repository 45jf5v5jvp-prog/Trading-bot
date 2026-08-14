import React, { useState, useEffect, useRef } from "react";

/**
 * ICARIA BOTS — clickable demo.
 *
 * Multiple bots run side by side. Each owns one token and holds both a buy leg
 * and a sell leg, because a round trip is one idea and splitting it across two
 * configs is how people end up with rules that fight each other.
 *
 * Everything is simulated. Every screen and every line of copy is what the real
 * product would say.
 */

const C = {
  bg: "#0B0B0D", panel: "#121215", edge: "#26262B", chip: "#1B1B1F",
  text: "#F5F3EF", ash: "#8A8B94", amber: "#C98A3E", glow: "#7A4E1E",
  good: "#4FBF8B", bad: "#E5484D",
};

const ICARIA_FEE = 0.15;
const ROUND_TRIP = 0.88;   // full cost of a round trip, not itemised in the UI
const PER_LEG = ROUND_TRIP / 2;
/**
 * Gas on PulseChain is calm most of the time and violent during launches. A
 * quiet swap runs a few hundred PLS; when a hot pair opens, bidding for
 * inclusion can push it to 20,000 PLS or well beyond. A bot that will not pay
 * up during a spike simply does not trade at the only moment it mattered.
 */
const GAS_CALM = 350;
const GAS_BUSY = 4_000;
const GAS_SPIKE = 25_000;

const n = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

const TIMEFRAMES = [
  { h: 1 / 120, l: "30s" }, { h: 1 / 60, l: "1m" }, { h: 0.05, l: "3m" },
  { h: 1 / 12, l: "5m" }, { h: 0.25, l: "15m" }, { h: 0.5, l: "30m" },
  { h: 1, l: "1h" }, { h: 2, l: "2h" }, { h: 4, l: "4h" },
  { h: 8, l: "8h" }, { h: 12, l: "12h" }, { h: 24, l: "24h" },
];
const tfLabel = (h) => TIMEFRAMES.find((t) => t.h === h)?.l ?? `${h}h`;

const WAITS = [
  { m: 0.5, l: "30s" }, { m: 1, l: "1m" }, { m: 2, l: "2m" }, { m: 5, l: "5m" },
  { m: 15, l: "15m" }, { m: 30, l: "30m" }, { m: 60, l: "1h" }, { m: 120, l: "2h" },
  { m: 240, l: "4h" }, { m: 720, l: "12h" }, { m: 1440, l: "24h" },
];

const typicalRange = (hours) => 12 * Math.sqrt(hours / 24);

function verdict(thresh, hours) {
  const typical = typicalRange(hours);
  const floor = ROUND_TRIP * 1.7;
  if (floor > typical * 2.2)
    return { ok: false, why: `On a ${tfLabel(hours)} chart price typically moves about ${typical.toFixed(2)}%, less than it costs to trade. No setting works here. Use a longer chart.` };
  if (thresh < floor)
    return { ok: false, why: `A ${thresh}% move doesn't cover what a round trip costs. This would lose money every time it fires.` };
  if (thresh > typical * 2.2)
    return { ok: false, why: `A ${thresh}% move on a ${tfLabel(hours)} chart is rare. Typical range is about ${typical.toFixed(2)}%, so this would almost never fire.` };
  return { ok: true, why: `Typical ${tfLabel(hours)} range is about ${typical.toFixed(2)}%. A ${thresh}% move leaves roughly ${(thresh - ROUND_TRIP).toFixed(2)}% after trading costs.` };
}

const newTradingBot = (id) => ({
  id, type: "trading", name: "INC dip buyer", token: "INC", look: 1, status: "running",
  buyOn: true, buyThresh: 5, buyAlloc: 10,
  sellOn: true, sellMode: "entry", sellThresh: 7, sellAlloc: 100,
  ladderOn: false, ladder: [{ at: 7, sell: 33 }, { at: 15, sell: 33 }, { at: 30, sell: 34 }],
  stopOn: true, stopThresh: 25,
  trailOn: false, trailThresh: 8,
  maxHold: 40, wait: 60, maxDay: 6, minTrade: "5000", gasCap: 5000, gasShare: 3,
});

const newLaunchBot = (id) => ({
  id, type: "launch", name: "Launch sniper", status: "paused",
  perLaunch: "25000", tp: 50, sl: 35, timeExit: 30, sellAtAll: true, maxPerDay: 4, gasCap: 30000, gasShare: 15,
});

function Sun({ size = 28, color = C.text }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill={color}>
      <path fillRule="evenodd" d="M50,50 m-27.5,0 a27.5,27.5 0 1,0 55,0 a27.5,27.5 0 1,0 -55,0 M50,50 m-23,0 a23,23 0 1,0 46,0 a23,23 0 1,0 -46,0" />
      <path d="M44.94,27.56 C46.36,20.02 56.67,8.33 59.77,4.03 C60.18,12.52 56.43,22.46 55.06,27.56 Z" />
      <path d="M55.18,27.59 C59.87,21.01 74.73,14.43 79.61,11.71 C76.04,19.95 67.93,27.74 64.29,31.98 Z" />
      <path d="M64.39,32.06 C70.96,28.68 86.04,29.63 91.14,29.42 C85.05,34.86 75.34,37.95 70.69,39.96 Z" />
      <path d="M70.75,40.08 C78.96,39.59 93.63,47.13 98.89,49.27 C90.06,51.64 78.70,50.14 73.00,49.94 Z" />
      <path d="M73.00,50.06 C79.86,53.11 88.70,65.59 92.10,69.50 C83.93,68.08 75.30,62.34 70.75,59.92 Z" />
      <path d="M70.69,60.04 C75.99,66.02 79.01,81.84 80.55,87.15 C73.38,81.92 67.67,72.39 64.39,67.94 Z" />
      <path d="M64.29,68.02 C66.01,75.00 61.68,89.13 60.74,94.01 C56.88,87.08 56.08,77.24 55.18,72.41 Z" />
      <path d="M55.06,72.44 C53.66,80.19 43.24,92.22 40.08,96.66 C39.69,87.93 43.54,77.69 44.94,72.44 Z" />
      <path d="M44.82,72.41 C40.11,79.04 25.18,85.70 20.27,88.45 C23.87,80.15 32.04,72.30 35.71,68.02 Z" />
      <path d="M35.61,67.94 C29.08,71.28 14.10,70.29 9.04,70.49 C15.07,65.09 24.70,62.03 29.31,60.04 Z" />
      <path d="M29.25,59.92 C21.33,60.31 7.17,52.82 2.11,50.72 C10.60,48.39 21.52,49.86 27.00,50.06 Z" />
      <path d="M27.00,49.94 C20.08,46.89 11.16,34.35 7.72,30.41 C15.96,31.85 24.66,37.64 29.25,40.08 Z" />
      <path d="M29.31,39.96 C23.96,33.95 20.88,18.04 19.32,12.69 C26.54,17.98 32.30,27.58 35.61,32.06 Z" />
      <path d="M35.71,31.98 C33.96,24.94 38.27,10.71 39.21,5.80 C43.09,12.79 43.91,22.72 44.82,27.59 Z" />
    </svg>
  );
}

const SEED_CLOSED = [
  { token: "FORGE9", bot: "Launch sniper", pnl: -2100, pct: -8.4, why: "Time limit" },
  { token: "HEX", bot: "HEX swinger", pnl: 4300, pct: 12.1, why: "Sell rule" },
  { token: "PLSX", bot: "INC dip buyer", pnl: 1850, pct: 6.2, why: "Sell rule" },
  { token: "0x8f2a", bot: "Launch sniper", pnl: -3400, pct: -22.0, why: "Stop loss" },
  { token: "WAIF", bot: "Launch sniper", pnl: 9600, pct: 54.0, why: "Take profit" },
];
const NEW_EVENTS = [
  { k: "skip", t: "Launch sniper", tok: "0xd7c4…19af", d: "Skipped. Only 12% of liquidity locked.", v: "" },
  { k: "buy", t: "HEX swinger", tok: "HEX", d: "Dropped 6.1% from 1h high", v: "−9,400 PLS" },
  { k: "skip", t: "INC dip buyer", tok: "INC", d: "Skipped. Holding cap reached.", v: "" },
  { k: "sell", t: "HEX swinger", tok: "HEX", d: "Up 7% on average cost", v: "+14,200 PLS" },
  { k: "skip", t: "INC dip buyer", tok: "INC", d: "Skipped. Waiting out the cooldown.", v: "" },
];

export default function Demo() {
  const [screen, setScreen] = useState("landing");
  const [tab, setTab] = useState("home");
  const [balance, setBalance] = useState(0);
  const [deposit, setDeposit] = useState("500000");
  const [chosenBot, setChosenBot] = useState("trading");

  const [bots, setBots] = useState([
    { ...newTradingBot(1) },
    { ...newTradingBot(2), name: "HEX swinger", token: "HEX", look: 4, buyThresh: 8, sellThresh: 12, ladderOn: true },
    { ...newLaunchBot(3) },
  ]);
  const [editing, setEditing] = useState(null);

  const [open, setOpen] = useState([
    { id: 1, botId: 1, bot: "INC dip buyer", token: "INC", spent: 50000, value: 54200, age: "6h 02m" },
    { id: 2, botId: 2, bot: "HEX swinger", token: "HEX", spent: 25000, value: 23100, age: "2h 14m" },
    { id: 3, botId: 3, bot: "Launch sniper", token: "GRIFT", spent: 25000, value: 38500, age: "41m" },
  ]);
  const [closed, setClosed] = useState(SEED_CLOSED);
  const [events, setEvents] = useState([
    { k: "buy", t: "INC dip buyer", tok: "INC", d: "Dropped 5.2% from 1h high", v: "−12,500 PLS" },
    { k: "skip", t: "Launch sniper", tok: "0x8f2a…c41d", d: "Skipped. Cannot sell after buying.", v: "" },
  ]);
  const [confirm, setConfirm] = useState(null);
  const [closingBot, setClosingBot] = useState(null);
  const [notify, setNotify] = useState(true);
  const idx = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      setOpen((ps) => ps.map((p) => ({ ...p, value: Math.max(100, p.value * (1 + (Math.random() - 0.48) * 0.04)) })));
    }, 2600);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (screen !== "app") return;
    const id = setInterval(() => {
      setEvents((prev) => [NEW_EVENTS[idx.current++ % NEW_EVENTS.length], ...prev].slice(0, 18));
    }, 5200);
    return () => clearInterval(id);
  }, [screen]);

  const saveBot = (b) => {
    setBots((bs) => (bs.some((x) => x.id === b.id) ? bs.map((x) => (x.id === b.id ? b : x)) : [...bs, b]));
    setEditing(null);
    setScreen("app");
    setTab("home");
  };

  const closePosition = (p) => {
    const pnl = Math.round(p.value - p.spent);
    setClosed((c) => [{ token: p.token, bot: p.bot, pnl, pct: (pnl / p.spent) * 100, why: "Closed by you" }, ...c]);
    setOpen((o) => o.filter((x) => x.id !== p.id));
    setBalance((b) => b + Math.round(p.value));
    setEvents((e) => [{ k: pnl >= 0 ? "sell" : "skip", t: p.bot, tok: p.token, d: "Closed manually", v: `${pnl >= 0 ? "+" : ""}${n(pnl)} PLS` }, ...e]);
    setConfirm(null);
  };

  /** Close bot: liquidate everything it holds, return the PLS, remove the bot. */
  const closeBot = (bot) => {
    const mine = open.filter((p) => p.botId === bot.id);
    const proceeds = mine.reduce((a, p) => a + p.value, 0);
    setClosed((c) => [
      ...mine.map((p) => ({ token: p.token, bot: p.bot, pnl: Math.round(p.value - p.spent), pct: ((p.value - p.spent) / p.spent) * 100, why: "Bot closed" })),
      ...c,
    ]);
    setOpen((o) => o.filter((p) => p.botId !== bot.id));
    setBalance((b) => b + Math.round(proceeds));
    setBots((bs) => bs.filter((b2) => b2.id !== bot.id));
    setEvents((e) => [{ k: "sell", t: bot.name, tok: `${mine.length} position${mine.length === 1 ? "" : "s"}`, d: "Bot closed, everything sold to PLS", v: `+${n(proceeds)} PLS` }, ...e]);
    setClosingBot(null);
  };

  const toggleBot = (id) =>
    setBots((bs) => bs.map((b) => (b.id === id ? { ...b, status: b.status === "running" ? "paused" : "running" } : b)));

  const totalPnl = closed.reduce((a, c) => a + c.pnl, 0);
  const wins = closed.filter((c) => c.pnl > 0).length;
  const stats = {
    totalPnl, wins, losses: closed.length - wins, trades: closed.length,
    openPnl: open.reduce((a, p) => a + (p.value - p.spent), 0),
  };

  return (
    <div className="min-h-screen w-full flex justify-center" style={{ background: C.bg }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@600;800&family=Newsreader:opsz,wght@6..72,300;6..72,400&display=swap');
        .brand{font-family:'Montserrat',system-ui,sans-serif}
        .say{font-family:'Newsreader',Georgia,serif}
        .num{font-variant-numeric:tabular-nums}
        input[type=range]{accent-color:${C.amber}}
      `}</style>

      <div className="w-full max-w-md relative pb-24" style={{ color: C.text, fontFamily: "ui-sans-serif,system-ui,sans-serif" }}>
        {screen === "landing" && <Landing pick={(b) => { setChosenBot(b); setScreen("connect"); }} />}
        {screen === "connect" && <Connect bot={chosenBot} go={() => setScreen("vault")} back={() => setScreen("landing")} />}
        {screen === "vault" && (
          <VaultSetup deposit={deposit} setDeposit={setDeposit} go={() => {
            setBalance(Number(deposit));
            setEditing(chosenBot === "launch" ? newLaunchBot(Date.now()) : newTradingBot(Date.now()));
            setScreen("edit");
          }} />
        )}

        {screen === "app" && tab === "home" && (
          <Home {...{ balance, stats, bots, open, events }}
            edit={(b) => { setEditing({ ...b }); setScreen("edit"); }}
            add={() => { setEditing(newTradingBot(Date.now())); setScreen("edit"); }}
            addLaunch={() => { setEditing(newLaunchBot(Date.now())); setScreen("edit"); }}
            toggle={toggleBot} closeBot={setClosingBot} goTab={setTab} />
        )}
        {screen === "app" && tab === "positions" && <Positions open={open} closed={closed} stats={stats} onClose={setConfirm} />}
        {screen === "app" && tab === "activity" && <Activity events={events} notify={notify} setNotify={setNotify} />}

        {screen === "edit" && editing?.type === "trading" && (
          <TradingCfg bot={editing} set={setEditing} balance={balance}
            back={() => { setEditing(null); setScreen("app"); }} save={() => saveBot(editing)} />
        )}
        {screen === "edit" && editing?.type === "launch" && (
          <LaunchCfg bot={editing} set={setEditing} balance={balance}
            back={() => { setEditing(null); setScreen("app"); }} save={() => saveBot(editing)} />
        )}

        {screen === "app" && <TabBar tab={tab} set={setTab} openCount={open.length} />}
        {confirm && <ConfirmClose p={confirm} onYes={() => closePosition(confirm)} onNo={() => setConfirm(null)} />}
        {closingBot && (
          <ConfirmCloseBot bot={closingBot} positions={open.filter((p) => p.botId === closingBot.id)}
            onYes={() => closeBot(closingBot)} onNo={() => setClosingBot(null)} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------- home / bot list ------------------------------- */

function Home({ balance, stats, bots, open, events, edit, add, addLaunch, toggle, closeBot, goTab }) {
  return (
    <div className="px-5 py-7">
      <div className="flex items-center justify-between mb-7">
        <div className="flex items-center gap-2.5"><Sun size={24} />
          <span className="brand text-[15px] tracking-[0.14em]" style={{ fontWeight: 800 }}>ICARIA</span>
        </div>
        <div className="w-8 h-8 rounded-full" style={{ background: C.chip }} />
      </div>

      <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: C.ash }}>Vault balance</div>
      <div className="num text-[34px] mb-1" style={{ fontWeight: 300 }}>{n(balance)} <span className="text-[18px]" style={{ color: C.ash }}>PLS</span></div>
      <button className="text-[12px] mb-6" style={{ color: C.amber }}>Add or withdraw ›</button>

      <button onClick={() => goTab("positions")} className="w-full rounded-2xl p-4 mb-7 flex justify-between items-center"
        style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
        <div className="text-left">
          <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: C.ash }}>Realised profit</div>
          <div className="num text-[20px]" style={{ color: stats.totalPnl >= 0 ? C.good : C.bad }}>
            {stats.totalPnl >= 0 ? "+" : ""}{n(stats.totalPnl)} PLS
          </div>
          <div className="text-[11px] mt-1" style={{ color: C.ash }}>
            {stats.wins} won · {stats.losses} lost · {open.length} open
          </div>
        </div>
        <span style={{ color: C.ash }}>›</span>
      </button>

      <div className="flex justify-between items-baseline mb-3">
        <span className="brand text-[10px] uppercase tracking-[0.2em]" style={{ color: C.ash }}>Your bots</span>
        <span className="text-[11px]" style={{ color: C.ash }}>{bots.filter((b) => b.status === "running").length} running</span>
      </div>

      {bots.map((b) => {
        const held = open.filter((p) => p.botId === b.id);
        const value = held.reduce((a, p) => a + p.value, 0);
        const running = b.status === "running";
        return (
          <div key={b.id} className="rounded-2xl p-4 mb-3" style={{ background: C.panel, border: `1px solid ${running ? C.edge : "#1a1a1e"}` }}>
            <button onClick={() => edit(b)} className="w-full flex justify-between items-start text-left mb-3">
              <div className="pr-3">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: running ? C.good : C.ash }} />
                  <span className="brand text-[14px] tracking-wide" style={{ fontWeight: 600, color: running ? C.text : C.ash }}>{b.name}</span>
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: C.ash }}>{summarise(b)}</div>
              </div>
              <span style={{ color: C.ash }}>›</span>
            </button>
            {held.length > 0 && (
              <div className="flex justify-between text-[11px] mb-3 pb-3" style={{ color: C.ash, borderBottom: `1px solid ${C.edge}` }}>
                <span>Holding {held.length} position{held.length === 1 ? "" : "s"}</span>
                <span className="num">{n(value)} PLS</span>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => toggle(b.id)} className="flex-1 py-2.5 rounded-lg text-[12px]"
                style={{ border: `1px solid ${C.edge}`, color: C.text }}>
                {running ? "Pause" : "Resume"}
              </button>
              <button onClick={() => closeBot(b)} className="flex-1 py-2.5 rounded-lg text-[12px]"
                style={{ border: `1px solid ${C.bad}55`, color: C.bad }}>
                Close bot
              </button>
            </div>
          </div>
        );
      })}

      <div className="flex gap-2 mt-4 mb-8">
        <button onClick={add} className="flex-1 py-3.5 rounded-xl text-[12px]" style={{ border: `1px dashed ${C.edge}`, color: C.amber }}>+ Trading Bot</button>
        <button onClick={addLaunch} className="flex-1 py-3.5 rounded-xl text-[12px]" style={{ border: `1px dashed ${C.edge}`, color: C.amber }}>+ Launch Bot</button>
      </div>

      <div className="flex justify-between items-baseline mb-2">
        <span className="brand text-[10px] uppercase tracking-[0.2em]" style={{ color: C.ash }}>Recent</span>
        <button onClick={() => goTab("activity")} className="text-[11px]" style={{ color: C.amber }}>See all ›</button>
      </div>
      {events.slice(0, 4).map((e, i) => <Event key={i} e={e} />)}
    </div>
  );
}

const summarise = (b) =>
  b.type === "launch"
    ? `New pairs · ${n(Number(b.perLaunch))} PLS each · ${b.sellAtAll ? `sell at +${b.tp}%` : "hold"}`
    : [b.buyOn && `buy ${b.buyAlloc}% on −${b.buyThresh}%`, b.sellOn && `sell on +${b.sellThresh}%`]
        .filter(Boolean).join(", ") + ` · ${b.token} ${tfLabel(b.look)}`;

function ConfirmCloseBot({ bot, positions, onYes, onNo }) {
  const proceeds = positions.reduce((a, p) => a + p.value, 0);
  const pnl = positions.reduce((a, p) => a + (p.value - p.spent), 0);
  return (
    <div className="fixed inset-0 flex items-end justify-center z-50" style={{ background: "#000000BB" }}>
      <div className="w-full max-w-md rounded-t-3xl p-6" style={{ background: C.panel }}>
        <div className="brand text-[15px] uppercase tracking-wide mb-3" style={{ fontWeight: 600 }}>Close {bot.name}?</div>
        <p className="say text-[14px] leading-relaxed mb-5" style={{ color: C.ash }}>
          {positions.length === 0
            ? "This bot isn't holding anything. Closing it just removes the bot and its settings."
            : `Everything this bot is holding gets sold to PLS right now and lands back in your vault, ready to withdraw. The bot and its settings are then removed.`}
        </p>

        {positions.length > 0 && (
          <div className="rounded-xl p-4 mb-5" style={{ background: C.chip }}>
            {positions.map((p) => (
              <div key={p.id} className="flex justify-between py-1 text-[12px]">
                <span style={{ color: C.ash }}>Sell all {p.token}</span>
                <span className="num">{n(p.value)} PLS</span>
              </div>
            ))}
            <div className="h-px my-2" style={{ background: C.edge }} />
            <Row l="Back into your vault" v={`${n(proceeds)} PLS`} strong />
            <Row l="Result on these" v={`${pnl >= 0 ? "+" : ""}${n(pnl)} PLS`} c={pnl >= 0 ? C.good : C.bad} />
            <Row l="Icaria fee" v={`${n(proceeds * ICARIA_FEE / 100)} PLS`} c={C.amber} />
          </div>
        )}

        <p className="say text-[12px] leading-relaxed mb-5" style={{ color: C.ash }}>
          Selling happens at whatever the market gives right now, which may be worse than
          your target. If you'd rather keep the tokens, pause the bot instead.
        </p>

        <button onClick={onYes} className="w-full py-4 rounded-xl brand text-[12px] uppercase tracking-[0.18em] mb-2"
          style={{ background: C.bad, color: C.text, fontWeight: 600 }}>Sell everything and close</button>
        <button onClick={onNo} className="w-full py-3 text-[12px]" style={{ color: C.ash }}>Cancel</button>
      </div>
    </div>
  );
}

/* ------------------------------- trading config ------------------------------- */

function TradingCfg({ bot, set, balance, back, save }) {
  const [added, setAdded] = useState(false);
  const u = (patch) => set({ ...bot, ...patch });
  const buyV = verdict(bot.buyThresh, bot.look);
  const cycleNet = bot.buyThresh + bot.sellThresh - ROUND_TRIP;
  const ok = (!bot.buyOn || buyV.ok) && (bot.buyOn || bot.sellOn);
  const ladderTotal = bot.ladder.reduce((a, l) => a + l.sell, 0);

  return (
    <Shell title="Trading Bot" back={back}>
      <input value={bot.name} onChange={(e) => u({ name: e.target.value })}
        className="w-full bg-transparent outline-none text-[20px] mb-6 pb-2"
        style={{ color: C.text, borderBottom: `1px solid ${C.edge}` }} />

      <Head>Token</Head>
      <div className="flex gap-2 mb-4 flex-wrap">
        {["PLS", "PLSX", "HEX", "INC", ...(added ? ["0x7A3F"] : [])].map((t) => (
          <button key={t} onClick={() => u({ token: t })} className="px-3 py-2 rounded-lg text-[12px]"
            style={{ background: bot.token === t ? C.panel : "transparent",
              border: `1px solid ${bot.token === t ? C.text : C.edge}`, color: bot.token === t ? C.text : C.ash }}>{t}</button>
        ))}
        <button onClick={() => setAdded(true)} className="px-3 py-2 rounded-lg text-[12px]"
          style={{ border: `1px dashed ${C.edge}`, color: C.amber }}>+ Add any token</button>
      </div>

      <Head>Chart</Head>
      <div className="flex gap-1.5 flex-wrap mb-2">
        {TIMEFRAMES.map((t) => (
          <button key={t.l} onClick={() => u({ look: t.h })} className="px-2.5 py-1.5 rounded-lg text-[11px] num"
            style={{ background: bot.look === t.h ? C.text : "transparent", color: bot.look === t.h ? C.bg : C.ash,
              border: `1px solid ${bot.look === t.h ? C.text : C.edge}` }}>{t.l}</button>
        ))}
      </div>

      <Leg on={bot.buyOn} set={(v) => u({ buyOn: v })} title="When to buy" tint={C.good}>
        <div className="say text-[17px] leading-loose mb-3" style={{ fontWeight: 300 }}>
          Buy <Pick opts={[5, 10, 15, 25, 50]} v={bot.buyAlloc} on={(v) => u({ buyAlloc: v })} sfx="%" /> of my vault
          whenever <span style={{ color: C.amber }}>{bot.token}</span> drops{" "}
          <Pick opts={[1, 2, 3, 5, 8, 10, 15, 20]} v={bot.buyThresh} on={(v) => u({ buyThresh: v })} sfx="%" />{" "}
          from its <span style={{ color: C.amber }}>{tfLabel(bot.look)}</span> high.
        </div>
        <Verdict thresh={bot.buyThresh} hours={bot.look} />
        <div className="mt-3">
          <Row l="Each buy" v={`${n((balance * bot.buyAlloc) / 100)} PLS`} />
        </div>
        <Slide l="Never hold more than" v={`${bot.maxHold}% of vault in ${bot.token}`} min={10} max={100} step={5}
          val={bot.maxHold} set={(v) => u({ maxHold: v })}
          help={`Once ${bot.maxHold}% of your vault is in ${bot.token}, buying stops. This is what keeps a dip buyer from putting everything you own into one falling token.`} />
      </Leg>

      <Leg on={bot.sellOn} set={(v) => u({ sellOn: v })} title="When to sell" tint={C.amber}>
        <div className="flex gap-2 mb-4">
          {[["entry", "From what I paid"], ["low", `From the ${tfLabel(bot.look)} low`]].map(([k, l]) => (
            <button key={k} onClick={() => u({ sellMode: k })} className="flex-1 py-2.5 rounded-lg text-[11px]"
              style={{ background: bot.sellMode === k ? C.panel : "transparent",
                border: `1px solid ${bot.sellMode === k ? C.text : C.edge}`, color: bot.sellMode === k ? C.text : C.ash }}>{l}</button>
          ))}
        </div>

        {!bot.ladderOn ? (
          <div className="say text-[17px] leading-loose mb-3" style={{ fontWeight: 300 }}>
            Sell <Pick opts={[25, 50, 75, 100]} v={bot.sellAlloc} on={(v) => u({ sellAlloc: v })} sfx="%" /> of my{" "}
            <span style={{ color: C.amber }}>{bot.token}</span> when{" "}
            {bot.sellMode === "entry" ? "I'm up " : "it rises "}
            <Pick opts={[2, 3, 5, 7, 10, 15, 25, 50]} v={bot.sellThresh} on={(v) => u({ sellThresh: v })} sfx="%" />
            {bot.sellMode === "entry" ? " on it." : ` from its ${tfLabel(bot.look)} low.`}
          </div>
        ) : (
          <div className="mb-3">
            {bot.ladder.map((rung, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <span className="text-[12px] w-16" style={{ color: C.ash }}>Sell</span>
                <Pick opts={[10, 20, 25, 33, 50]} v={rung.sell}
                  on={(v) => u({ ladder: bot.ladder.map((r, j) => (j === i ? { ...r, sell: v } : r)) })} sfx="%" />
                <span className="text-[12px]" style={{ color: C.ash }}>at</span>
                <Pick opts={[3, 5, 7, 10, 15, 25, 50, 100]} v={rung.at}
                  on={(v) => u({ ladder: bot.ladder.map((r, j) => (j === i ? { ...r, at: v } : r)) })} sfx="%" />
              </div>
            ))}
            <div className="text-[11px] mt-2" style={{ color: ladderTotal > 100 ? C.bad : C.ash }}>
              {ladderTotal > 100
                ? `Adds to ${ladderTotal}%, which is more than you hold.`
                : `Sells ${ladderTotal}% in total, keeping ${100 - ladderTotal}% running.`}
            </div>
          </div>
        )}

        <button onClick={() => u({ ladderOn: !bot.ladderOn })} className="text-[12px] mb-3" style={{ color: C.amber }}>
          {bot.ladderOn ? "Use a single target instead" : "Sell in stages instead ›"}
        </button>

        <div className="say text-[12px] leading-relaxed" style={{ color: C.ash }}>
          {bot.sellMode === "entry"
            ? `Measured against your average cost. If the bot buys three times at different prices it uses the blended figure, so "up" always means up on your actual money.`
            : `Measured against the market, not your entry. This can sell at a loss if the price fell before it bounced.`}
        </div>
      </Leg>

      <Leg on={bot.trailOn} set={(v) => u({ trailOn: v })} title="Trailing stop" tint={C.amber}>
        <Slide l="Sell if it falls back" v={`${bot.trailThresh}% from its high`} min={3} max={40} step={1}
          val={bot.trailThresh} set={(v) => u({ trailThresh: v })}
          help={`Once you're in profit, this follows the price up and sells if it drops ${bot.trailThresh}% from the best level reached. It lets a winner run instead of capping it at your target.`} />
      </Leg>

      <Leg on={bot.stopOn} set={(v) => u({ stopOn: v })} title="Cut losses" tint={C.bad}>
        <Slide l="Sell everything if I'm down" v={`−${bot.stopThresh}%`} min={5} max={80} step={5}
          val={bot.stopThresh} set={(v) => u({ stopThresh: v })}
          help={`Exits the whole position if it falls ${bot.stopThresh}% below your average cost, and pauses this bot so it doesn't buy straight back in.`} />
      </Leg>

      {bot.buyOn && bot.sellOn && !bot.ladderOn && (
        <div className="rounded-2xl p-5 mb-5" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
          <div className="brand text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: C.amber }}>One full cycle</div>
          <div className="flex items-center gap-3 mb-3">
            <Step n="1" t={`Drops ${bot.buyThresh}%`} c={C.good} />
            <span style={{ color: C.ash }}>→</span>
            <Step n="2" t={`Up ${bot.sellThresh}%`} c={C.amber} />
            <span style={{ color: C.ash }}>→</span>
            <Step n="3" t="Repeat" c={C.ash} />
          </div>
          <Row l="Gross on a full cycle" v={`+${(bot.buyThresh + bot.sellThresh).toFixed(1)}%`} />
          <Row l="After trading costs" v={`+${cycleNet.toFixed(2)}%`} c={cycleNet > 1 ? C.good : C.bad} />
          <p className="say text-[12px] leading-relaxed mt-3" style={{ color: C.ash }}>
            {cycleNet > 1
              ? "That's the good case, where it dips, you buy, it recovers and you sell. The bad case is it dips, you buy, and it keeps falling. That's what the stop is for."
              : "Too thin. After costs this cycle barely clears zero, so widen one side or both."}
          </p>
        </div>
      )}

      <Head>How often</Head>
      <div className="text-[12px] mb-2" style={{ color: C.ash }}>Wait between trades</div>
      <div className="flex gap-1.5 flex-wrap mb-4">
        {WAITS.map((w) => (
          <button key={w.l} onClick={() => u({ wait: w.m })} className="px-2.5 py-1.5 rounded-lg text-[11px] num"
            style={{ background: bot.wait === w.m ? C.text : "transparent", color: bot.wait === w.m ? C.bg : C.ash,
              border: `1px solid ${bot.wait === w.m ? C.text : C.edge}` }}>{w.l}</button>
        ))}
      </div>
      <Slide l="Most trades per day" v={`${bot.maxDay}`} min={1} max={200} step={1} val={bot.maxDay} set={(v) => u({ maxDay: v })}
        help={`Hard ceiling. This bot stops for the day once it hits ${bot.maxDay}.`} />

      <Burn wait={bot.wait} maxDay={bot.maxDay} alloc={bot.buyAlloc} />

      <Head>When funds run low</Head>
      <div className="text-[12px] mb-2" style={{ color: C.ash }}>Don't trade below</div>
      <AmountBox v={bot.minTrade} on={(v) => u({ minTrade: v })} of={balance} />
      <div className="rounded-xl p-3 mb-6 say text-[12px] leading-relaxed" style={{ background: C.chip, color: C.ash }}>
        Each buy is {bot.buyAlloc}% of what's left, so without a floor the bot keeps firing
        ever smaller trades that cost more in fees than they're worth. Below{" "}
        {n(Number(bot.minTrade) || 0)} PLS it pauses and tells you to top up. An empty vault
        does nothing at all.
      </div>

      <GasPanel size={(balance * bot.buyAlloc) / 100} cap={bot.gasCap} setCap={(v) => u({ gasCap: v })} shareCap={bot.gasShare} setShareCap={(v) => u({ gasShare: v })} />

      <Btn onClick={save} disabled={!ok}>
        {!bot.buyOn && !bot.sellOn ? "Turn on at least one side" : ok ? "Save and run" : "Fix the buy settings"}
      </Btn>
      <div className="h-8" />
    </Shell>
  );
}

/* ------------------------------- launch config ------------------------------- */

function LaunchCfg({ bot, set, balance, back, save }) {
  const u = (patch) => set({ ...bot, ...patch });
  return (
    <Shell title="Launch Bot" back={back}>
      <input value={bot.name} onChange={(e) => u({ name: e.target.value })}
        className="w-full bg-transparent outline-none text-[20px] mb-5 pb-2"
        style={{ color: C.text, borderBottom: `1px solid ${C.edge}` }} />
      <p className="say text-[15px] leading-relaxed mb-6" style={{ color: C.ash }}>
        Buys a token the moment it opens on PulseX, but only after checking it can
        actually be sold again. Most new tokens fail that check.
      </p>

      <Head>Spend per launch</Head>
      <AmountBox v={bot.perLaunch} on={(v) => u({ perLaunch: v })} of={balance} />
      <Slide l="Most launches per day" v={`${bot.maxPerDay}`} min={1} max={30} val={bot.maxPerDay} set={(v) => u({ maxPerDay: v })}
        help={`Caps your exposure at ${n(Number(bot.perLaunch) * bot.maxPerDay)} PLS a day.`} />

      <Head>What happens next</Head>
      <div className="flex gap-2 mb-4">
        {[[true, "Sell at a target"], [false, "Just hold it"]].map(([val, label]) => (
          <button key={label} onClick={() => u({ sellAtAll: val })} className="flex-1 py-3 rounded-xl text-[12px]"
            style={{ background: bot.sellAtAll === val ? C.panel : "transparent",
              border: `1px solid ${bot.sellAtAll === val ? C.text : C.edge}`, color: bot.sellAtAll === val ? C.text : C.ash }}>{label}</button>
        ))}
      </div>
      {bot.sellAtAll ? (
        <>
          <Slide l="Sell when it's up" v={`+${bot.tp}%`} min={10} max={500} step={10} val={bot.tp} set={(v) => u({ tp: v })}
            help={`Takes your profit as soon as it gains ${bot.tp}%.`} />
          <Slide l="Sell when it's down" v={bot.sl === 0 ? "Never" : `−${bot.sl}%`} min={0} max={90} step={5} val={bot.sl} set={(v) => u({ sl: v })}
            help={bot.sl === 0 ? "Off. If it falls, the bot holds and you close it yourself." : `Cuts the loss if it falls ${bot.sl}%.`} />
          <Slide l="Sell anyway after" v={bot.timeExit === 0 ? "Never" : `${bot.timeExit} min`} min={0} max={240} step={10} val={bot.timeExit} set={(v) => u({ timeExit: v })}
            help={bot.timeExit === 0
              ? "Off. If it goes nowhere, your PLS stays in the token until you close it."
              : `The time limit. If neither number is hit in ${bot.timeExit} minutes, sell anyway. Most launches do nothing at all, and this stops your money sitting in one.`} />
          {bot.tp >= 60 && bot.timeExit > 0 && bot.timeExit <= 120 && (
            <div className="rounded-lg p-3 mb-5 say text-[12px] leading-relaxed" style={{ background: "#241A0C", color: C.amber }}>
              A +{bot.tp}% target inside {bot.timeExit} minutes is a tall order. Expect most
              positions to close on the time limit rather than the target.
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl p-3 mb-5 say text-[12px] leading-relaxed" style={{ background: C.chip, color: C.ash }}>
          The bot buys and stops there. It appears under Positions and you close it yourself.
        </div>
      )}

      <Head>Safety checks</Head>
      {["Must be sellable after buying", "Liquidity locked or burned", "Sell tax under 10%",
        "Deployer holds under 15%", "Liquidity over 2M PLS"].map((c) => (
        <div key={c} className="flex gap-2.5 items-center mb-2.5">
          <span className="text-[11px]" style={{ color: C.good }}>✓</span>
          <span className="text-[12px]" style={{ color: C.ash }}>{c}</span>
        </div>
      ))}
      <div className="rounded-xl p-3 my-5 say text-[12px] leading-relaxed" style={{ background: C.chip, color: C.ash }}>
        Screening cuts out most bad tokens. It does not make this safe. Only spend what you
        could lose entirely.
      </div>

      <GasPanel size={Number(bot.perLaunch) || 0} cap={bot.gasCap} setCap={(v) => u({ gasCap: v })} shareCap={bot.gasShare} setShareCap={(v) => u({ gasShare: v })} />

      <Btn onClick={save}>Save and run</Btn>
      <div className="h-8" />
    </Shell>
  );
}

/* ------------------------------- positions ------------------------------- */

function Positions({ open, closed, stats, onClose }) {
  return (
    <div className="px-5 py-7">
      <div className="brand text-[15px] uppercase tracking-[0.16em] mb-6" style={{ fontWeight: 600 }}>Positions</div>
      <Scorecard stats={stats} />
      <Head>Open · {open.length}</Head>
      {open.length === 0 && <Empty t="Nothing open" d="Positions your bots take will appear here." />}
      {open.map((p) => {
        const pnl = p.value - p.spent;
        return (
          <div key={p.id} className="rounded-2xl p-4 mb-3" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
            <div className="flex justify-between items-start mb-3">
              <div>
                <div className="text-[15px]">{p.token}</div>
                <div className="text-[11px] mt-0.5" style={{ color: C.ash }}>{p.bot} · {p.age}</div>
              </div>
              <div className="text-right">
                <div className="num text-[16px]" style={{ color: pnl >= 0 ? C.good : C.bad }}>{pct((pnl / p.spent) * 100)}</div>
                <div className="num text-[11px]" style={{ color: C.ash }}>{pnl >= 0 ? "+" : ""}{n(pnl)} PLS</div>
              </div>
            </div>
            <div className="flex justify-between text-[11px] mb-3" style={{ color: C.ash }}>
              <span>In {n(p.spent)} PLS</span><span>Now {n(p.value)} PLS</span>
            </div>
            <button onClick={() => onClose(p)} className="w-full py-2.5 rounded-lg text-[12px]"
              style={{ border: `1px solid ${C.edge}`, color: C.text }}>Close position now</button>
          </div>
        );
      })}
      <Head>Closed · {closed.length}</Head>
      {closed.map((c, i) => (
        <div key={i} className="flex justify-between items-center py-2.5" style={{ borderBottom: `1px solid ${C.edge}` }}>
          <div>
            <div className="text-[13px]">{c.token}</div>
            <div className="text-[10px] mt-0.5" style={{ color: C.ash }}>{c.bot} · {c.why}</div>
          </div>
          <div className="text-right">
            <div className="num text-[13px]" style={{ color: c.pnl >= 0 ? C.good : C.bad }}>{pct(c.pct)}</div>
            <div className="num text-[10px]" style={{ color: C.ash }}>{c.pnl >= 0 ? "+" : ""}{n(c.pnl)} PLS</div>
          </div>
        </div>
      ))}
      <button className="w-full py-3 mt-5 rounded-xl text-[12px]" style={{ border: `1px solid ${C.edge}`, color: C.ash }}>
        Export all trades as CSV
      </button>
      <div className="h-4" />
    </div>
  );
}

function Scorecard({ stats }) {
  const rate = stats.trades ? (stats.wins / stats.trades) * 100 : 0;
  const up = stats.totalPnl >= 0;
  return (
    <div className="rounded-2xl p-5 mb-6" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
      <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: C.ash }}>Realised profit</div>
      <div className="num text-[30px] mb-1" style={{ color: up ? C.good : C.bad, fontWeight: 300 }}>
        {up ? "+" : ""}{n(stats.totalPnl)} <span className="text-[15px]" style={{ color: C.ash }}>PLS</span>
      </div>
      <div className="text-[11px] mb-4" style={{ color: C.ash }}>
        Open positions {stats.openPnl >= 0 ? "up" : "down"} {n(Math.abs(stats.openPnl))} PLS
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden mb-2" style={{ background: C.chip }}>
        <div style={{ width: `${rate}%`, background: C.good }} />
        <div style={{ width: `${100 - rate}%`, background: C.bad }} />
      </div>
      <div className="flex justify-between text-[11px]" style={{ color: C.ash }}>
        <span><span style={{ color: C.good }}>{stats.wins} won</span> · <span style={{ color: C.bad }}>{stats.losses} lost</span></span>
        <span className="num">{rate.toFixed(0)}% win rate</span>
      </div>
      <p className="say text-[11px] leading-relaxed mt-3" style={{ color: C.ash }}>
        Win rate alone doesn't tell you much. Four small wins and one large loss is a losing
        month. The PLS figure is the one that matters.
      </p>
    </div>
  );
}

function ConfirmClose({ p, onYes, onNo }) {
  const pnl = p.value - p.spent;
  return (
    <div className="fixed inset-0 flex items-end justify-center z-50" style={{ background: "#000000AA" }}>
      <div className="w-full max-w-md rounded-t-3xl p-6" style={{ background: C.panel }}>
        <div className="brand text-[14px] uppercase tracking-wide mb-3" style={{ fontWeight: 600 }}>Close {p.token}?</div>
        <p className="say text-[14px] leading-relaxed mb-5" style={{ color: C.ash }}>
          Sells your whole {p.token} position back to PLS at the current price. This locks in{" "}
          <span style={{ color: pnl >= 0 ? C.good : C.bad }}>{pnl >= 0 ? "+" : ""}{n(pnl)} PLS</span>.
          The bot keeps running and may buy again if your rule triggers.
        </p>
        <div className="rounded-xl p-3 mb-5" style={{ background: C.chip }}>
          <Row l="Icaria fee on this trade" v={`${n(p.value * ICARIA_FEE / 100)} PLS`} c={C.amber} />
        </div>
        <button onClick={onYes} className="w-full py-4 rounded-xl brand text-[12px] uppercase tracking-[0.18em] mb-2"
          style={{ background: C.text, color: C.bg, fontWeight: 600 }}>Close position</button>
        <button onClick={onNo} className="w-full py-3 text-[12px]" style={{ color: C.ash }}>Keep it open</button>
      </div>
    </div>
  );
}

/* ------------------------------- activity ------------------------------- */

function Activity({ events, notify, setNotify }) {
  return (
    <div className="px-5 py-7">
      <div className="brand text-[15px] uppercase tracking-[0.16em] mb-4" style={{ fontWeight: 600 }}>Activity</div>
      <button onClick={() => setNotify(!notify)} className="w-full flex items-center justify-between rounded-xl p-4 mb-6"
        style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
        <div className="text-left">
          <div className="text-[13px]">Telegram alerts</div>
          <div className="text-[11px] mt-0.5" style={{ color: C.ash }}>Every buy, sell and stop, as it happens</div>
        </div>
        <span className="w-10 h-6 rounded-full flex items-center px-0.5"
          style={{ background: notify ? C.good : C.edge, justifyContent: notify ? "flex-end" : "flex-start" }}>
          <span className="w-5 h-5 rounded-full block" style={{ background: notify ? C.bg : C.ash }} />
        </span>
      </button>
      <p className="say text-[14px] leading-relaxed mb-5" style={{ color: C.ash }}>
        Everything the bots did, including everything they refused to do and why.
      </p>
      {events.map((e, i) => <Event key={i} e={e} />)}
    </div>
  );
}

/* ------------------------------- landing / onboarding ------------------------------- */

function Landing({ pick }) {
  return (
    <div className="px-5 py-10 relative min-h-screen">
      <div className="absolute inset-x-0 top-0 h-96 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at 50% 0%, ${C.glow}45, transparent 60%)` }} />
      <div className="relative">
        <div className="flex items-center gap-3 mb-14">
          <Sun size={30} />
          <span className="brand text-[20px] tracking-[0.14em]" style={{ fontWeight: 800 }}>ICARIA</span>
        </div>
        <h1 className="say text-[36px] leading-[1.1] mb-4" style={{ fontWeight: 300 }}>
          Trading bots for<br /><span style={{ color: C.amber }}>PulseChain.</span>
        </h1>
        <p className="say text-[16px] leading-relaxed mb-11" style={{ color: C.ash, fontWeight: 300 }}>
          Set the rules once in plain English. The bot watches PulseX and acts while you
          get on with your day. Pick one to begin.
        </p>

        <BotChoice name="Trading Bot" tag="For tokens you already follow"
          body="One bot per token, with both sides in it. Buy INC whenever it drops 5%, sell when you're up 7%, and repeat. Add a trailing stop to let winners run, or sell in stages on the way up."
          points={["Any token traded on PulseX", "Buy and sell in one bot", "Charts from 5 minutes to 24 hours"]}
          onClick={() => pick("trading")} />

        <BotChoice name="Launch Bot" tag="For brand new tokens"
          body="Buys the moment a token opens on PulseX, but only after checking you could sell it again. Most new tokens fail that check and get skipped. Set a target and it takes profit for you, or leave it off and hold."
          points={["Screens every token before buying", "Take profit, stop loss and a time limit", "Daily spending cap you control"]}
          onClick={() => pick("launch")} />

        <div className="rounded-2xl p-5 mt-8" style={{ background: C.chip }}>
          <div className="brand text-[10px] uppercase tracking-[0.2em] mb-2.5" style={{ color: C.amber }}>The short version</div>
          <div className="say text-[14px] leading-relaxed" style={{ color: C.ash }}>
            <p className="mb-2.5">Your funds sit in a vault only you can withdraw from. We never hold your tokens and never see your keys.</p>
            <p className="mb-2.5">Icaria charges {ICARIA_FEE}% per trade. Network gas comes out of your vault and varies with how busy PulseChain is. Nothing else, no subscription.</p>
            <p>Trading is risky and you can lose everything you put in. Nothing here is financial advice, and we don't pick your strategy.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function BotChoice({ name, tag, body, points, onClick }) {
  return (
    <div className="rounded-2xl p-6 mb-4" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
      <div className="brand text-[18px] uppercase tracking-wide mb-1" style={{ fontWeight: 600 }}>{name}</div>
      <div className="say text-[14px] mb-4" style={{ color: C.amber }}>{tag}</div>
      <p className="say text-[15px] leading-relaxed mb-5" style={{ color: C.ash, fontWeight: 300 }}>{body}</p>
      {points.map((p) => (
        <div key={p} className="flex gap-2.5 items-start mb-2.5">
          <span className="text-[11px] mt-1" style={{ color: C.good }}>✓</span>
          <span className="text-[12px]" style={{ color: C.ash }}>{p}</span>
        </div>
      ))}
      <button onClick={onClick} className="w-full py-3.5 rounded-xl brand text-[12px] uppercase tracking-[0.18em] mt-5 active:scale-[0.98] transition-transform"
        style={{ background: C.text, color: C.bg, fontWeight: 600 }}>Set up {name}</button>
    </div>
  );
}

function Connect({ bot, go, back }) {
  const [busy, setBusy] = useState(false);
  const label = bot === "launch" ? "Launch Bot" : "Trading Bot";
  return (
    <Shell title="Connect wallet" back={back}>
      <p className="say text-[15px] leading-relaxed mb-6" style={{ color: C.ash }}>
        Connect the wallet you already use on PulseChain to set up your {label}.
      </p>
      <div className="rounded-2xl p-5 mb-7" style={{ background: C.chip, border: `1px solid ${C.edge}` }}>
        <div className="brand text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: C.amber }}>
          What connecting does and doesn't do
        </div>
        {[
          ["We never see your private key or seed phrase.", "There is nowhere on this site to type one. If any site ever asks you for a seed phrase, it is stealing from you."],
          ["Connecting only shares your public address.", "The same address anyone can already look up on a block explorer."],
          ["We cannot move your tokens.", "Your funds go into a vault contract at your own address. Only you can withdraw from it."],
          ["The bot can swap, and nothing else.", "It trades inside your vault and has no way to send anything to another address, including ours."],
          ["You can cut it off at any time.", "Withdraw everything in one transaction, or revoke the bot's permission. Both work even if our servers are down."],
        ].map(([t, d]) => (
          <div key={t} className="flex gap-2.5 mb-3.5 last:mb-0">
            <span className="text-[11px] mt-1 shrink-0" style={{ color: C.good }}>✓</span>
            <div>
              <div className="text-[13px] leading-snug">{t}</div>
              <div className="say text-[12px] leading-relaxed mt-0.5" style={{ color: C.ash }}>{d}</div>
            </div>
          </div>
        ))}
      </div>
      {[["MetaMask", "Most common"], ["Rabby", "Built for DeFi"], ["WalletConnect", "Everything else"]].map(([w, sub]) => (
        <button key={w} onClick={() => { setBusy(true); setTimeout(go, 700); }}
          className="w-full flex items-center justify-between rounded-xl px-4 py-4 mb-3"
          style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
          <div className="text-left">
            <div className="text-[14px]">{w}</div>
            <div className="text-[11px]" style={{ color: C.ash }}>{sub}</div>
          </div>
          <span style={{ color: C.ash }}>›</span>
        </button>
      ))}
      {busy && <div className="text-[12px] mt-4 text-center" style={{ color: C.amber }}>Connecting…</div>}
      <div className="h-8" />
    </Shell>
  );
}

function VaultSetup({ deposit, setDeposit, go }) {
  const [step, setStep] = useState(0);
  return (
    <Shell title="Your vault">
      {step === 0 ? (
        <>
          <div className="say text-[15px] leading-relaxed mb-6" style={{ color: C.ash }}>
            <p className="mb-3">Your wallet is your house. Your vault is a lockbox you put on the porch, and you hold the only key that opens it.</p>
            <p className="mb-3">The bot gets a different key. It can take money from the lockbox to the exchange, buy or sell, and put the result straight back. That key can never open the lockbox and carry anything away.</p>
            <p style={{ color: C.text }}>Icaria never holds your tokens. Empty it in one tap, any time.</p>
          </div>
          <div className="rounded-xl p-4 mb-6" style={{ background: C.chip }}>
            <Row l="Cost to deploy" v="~400 PLS in gas" />
            <Row l="Gas per trade after" v={`${n(GAS_CALM)} PLS, more when busy`} />
          </div>
          <Btn onClick={() => setStep(1)}>Deploy my vault</Btn>
        </>
      ) : (
        <>
          <p className="say text-[15px] leading-relaxed mb-6" style={{ color: C.ash }}>
            Vault deployed. Move any amount of PLS in to get started.
          </p>
          <div className="text-[12px] mb-2" style={{ color: C.ash }}>Deposit</div>
          <div className="flex items-center rounded-xl px-4 py-3 mb-3" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
            <input inputMode="decimal" value={n(Number(deposit) || 0)}
              onChange={(e) => setDeposit(String(Number(e.target.value.replace(/\D/g, "")) || 0))}
              className="flex-1 bg-transparent outline-none text-[20px] num" style={{ color: C.text }} />
            <span className="text-[13px]" style={{ color: C.ash }}>PLS</span>
          </div>
          <div className="flex gap-2 mb-8">
            {[100000, 500000, 1000000, 5000000].map((v) => (
              <button key={v} onClick={() => setDeposit(String(v))} className="flex-1 py-2 rounded-lg text-[11px]"
                style={{ background: C.chip, color: C.ash, border: `1px solid ${C.edge}` }}>
                {v >= 1000000 ? `${v / 1000000}M` : `${v / 1000}k`}
              </button>
            ))}
          </div>
          <Btn onClick={go}>Deposit and continue</Btn>
        </>
      )}
    </Shell>
  );
}

/* ------------------------------- primitives ------------------------------- */

function Shell({ title, back, children }) {
  return (
    <div className="px-5 py-7">
      <div className="flex items-center gap-3 mb-7">
        {back && <button onClick={back} className="text-[20px]" style={{ color: C.ash }}>‹</button>}
        <span className="brand text-[15px] uppercase tracking-[0.16em]" style={{ fontWeight: 600 }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function Leg({ on, set, title, tint, children }) {
  return (
    <div className="rounded-2xl mb-4 overflow-hidden" style={{ background: C.panel, border: `1px solid ${on ? tint + "55" : C.edge}` }}>
      <button onClick={() => set(!on)} className="w-full flex items-center justify-between px-5 py-4">
        <span className="brand text-[13px] uppercase tracking-wide" style={{ fontWeight: 600, color: on ? C.text : C.ash }}>{title}</span>
        <span className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors"
          style={{ background: on ? tint : C.edge, justifyContent: on ? "flex-end" : "flex-start" }}>
          <span className="w-5 h-5 rounded-full block" style={{ background: on ? C.bg : C.ash }} />
        </span>
      </button>
      {on && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

/**
 * Fees are charged per trade, so cost scales with how often you fire and how big
 * each trade is, not with whether you were right. That number belongs on screen
 * next to the controls that produce it.
 */
function Burn({ wait, maxDay, alloc }) {
  const perDay = Math.min(maxDay, Math.floor((24 * 60) / wait));
  const dailyPct = perDay * (alloc / 100) * (PER_LEG / 100) * 100;
  const monthly = (1 - Math.pow(1 - dailyPct / 100, 30)) * 100;
  const hot = dailyPct > 1.5, warm = dailyPct > 0.5;
  const col = hot ? C.bad : warm ? C.amber : C.good;
  return (
    <div className="rounded-xl p-4 mb-5" style={{ background: hot ? "#2A1012" : C.chip }}>
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-[12px]" style={{ color: C.ash }}>Up to</span>
        <span className="num text-[15px]">{perDay} trades a day</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden mb-3" style={{ background: C.edge }}>
        <div className="h-full transition-all" style={{ width: `${Math.min(100, dailyPct * 20)}%`, background: col }} />
      </div>
      <Row l="Fees at this setting" v={`${dailyPct.toFixed(2)}% of vault per day`} c={col} />
      <Row l="Over a month" v={`about ${monthly.toFixed(0)}%`} c={col} />
      <p className="say text-[12px] leading-relaxed mt-3" style={{ color: hot ? C.bad : C.ash }}>
        {hot ? `At this pace fees alone take roughly ${monthly.toFixed(0)}% of your vault a month. Every trade has to beat that before you make anything.`
          : warm ? `Fees run about ${monthly.toFixed(0)}% a month. Workable if your rule genuinely has an edge, expensive if it doesn't.`
          : `A reasonable pace. Fees stay out of the way and your rule does the work.`}
      </p>
    </div>
  );
}

/**
 * Gas is a flat cost per trade, so it barely registers on a large trade and
 * dominates a small one. A 5,000 PLS trade pays 7% of itself in gas. Showing
 * the percentage is the only way people notice.
 */
function GasPanel({ size, cap, setCap, shareCap, setShareCap }) {
  const feePls = size * (ICARIA_FEE / 100);
  const pctOf = (g) => (size > 0 ? (g / size) * 100 : 0);
  const allowed = Math.min(cap, (size * shareCap) / 100);
  const coversSpike = allowed >= GAS_SPIKE;

  return (
    <div className="rounded-xl p-4 mb-6" style={{ background: C.chip }}>
      <div className="brand text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: C.ash }}>
        Costs and gas
      </div>
      <Row l="Icaria fee" v={`${ICARIA_FEE}% · ${n(feePls)} PLS`} c={C.amber} />
      <div className="h-px my-2" style={{ background: C.edge }} />

      {[["Quiet network", GAS_CALM], ["Busy", GAS_BUSY], ["Launch spike", GAS_SPIKE]].map(([l, g]) => {
        const over = g > allowed;
        return (
          <Row key={l} l={l} c={over ? C.bad : pctOf(g) > 3 ? C.amber : C.text}
            v={`${n(g)} PLS · ${pctOf(g).toFixed(1)}%${over ? " · skipped" : ""}`} />
        );
      })}

      <div className="mt-4">
        <Slide l="Most gas I'll pay per trade" v={`${n(cap)} PLS`} min={500} max={60000} step={500}
          val={cap} set={setCap}
          help="Raise this before a launch you care about. During a spike a transaction that doesn't bid up just sits there, which for a sniper is the same as not trading." />
        <Slide l="And never more than" v={`${shareCap}% of the trade`} min={1} max={20} step={1}
          val={shareCap} set={setShareCap}
          help={`Stops the bot paying ${n(GAS_SPIKE)} PLS in gas to make a ${n(size)} PLS trade. Whichever limit is lower wins.`} />
      </div>

      <div className="rounded-lg p-3 mt-1 say text-[12px] leading-relaxed"
        style={{ background: coversSpike ? "#0F2A20" : "#241A0C", color: coversSpike ? C.good : C.amber }}>
        {coversSpike
          ? `Your limit works out to ${n(allowed)} PLS, enough to bid through a launch spike. You'll get filled when it's busy.`
          : `Your limit works out to ${n(allowed)} PLS. During a launch spike the bot will skip rather than overpay. Safer, but you'll miss the busiest moments. Trade larger or lift a limit to change that.`}
      </div>

      <p className="say text-[12px] leading-relaxed mt-3" style={{ color: C.ash }}>
        Gas comes out of your vault and is a flat charge, so it barely registers on a
        large trade and dominates a small one. Nothing is charged on a trade that gets
        skipped.
      </p>
    </div>
  );
}

function Verdict({ thresh, hours }) {
  const v = verdict(thresh, hours);
  return (
    <div className="rounded-xl px-4 py-3 flex gap-2.5" style={{ background: v.ok ? C.chip : "#2A1012" }}>
      <span className="text-[14px] shrink-0" style={{ color: v.ok ? C.good : C.bad }}>{v.ok ? "✓" : "!"}</span>
      <p className="say text-[13px] leading-relaxed" style={{ color: v.ok ? C.ash : C.bad }}>{v.why}</p>
    </div>
  );
}

function Event({ e }) {
  const col = e.k === "skip" ? C.ash : e.k === "sell" ? C.good : C.text;
  const mark = e.k === "skip" ? "—" : e.k === "sell" ? "↑" : "↓";
  return (
    <div className="flex gap-3 py-2.5" style={{ borderBottom: `1px solid ${C.edge}` }}>
      <span className="text-[12px] w-3 shrink-0" style={{ color: col }}>{mark}</span>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between gap-2">
          <span className="text-[13px] truncate">{e.tok}</span>
          <span className="num text-[12px] shrink-0" style={{ color: e.k === "sell" ? C.good : C.ash }}>{e.v}</span>
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: C.ash }}>{e.t} · {e.d}</div>
      </div>
    </div>
  );
}

function TabBar({ tab, set, openCount }) {
  const items = [["home", "Bots"], ["positions", `Positions${openCount ? ` (${openCount})` : ""}`], ["activity", "Activity"]];
  return (
    <div className="fixed bottom-0 left-0 right-0 flex justify-center">
      <div className="w-full max-w-md flex" style={{ background: C.panel, borderTop: `1px solid ${C.edge}` }}>
        {items.map(([k, l]) => (
          <button key={k} onClick={() => set(k)} className="flex-1 py-4 text-[11px]"
            style={{ color: tab === k ? C.text : C.ash, borderTop: `2px solid ${tab === k ? C.amber : "transparent"}` }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

const Head = ({ children }) => (
  <div className="brand text-[10px] uppercase tracking-[0.2em] mb-3 mt-6 pb-1.5"
    style={{ color: C.ash, borderBottom: `1px solid ${C.edge}` }}>{children}</div>
);

const Row = ({ l, v, c, strong }) => (
  <div className="flex justify-between py-1 text-[12px]">
    <span style={{ color: C.ash }}>{l}</span>
    <span className="num" style={{ color: c || C.text, fontWeight: strong ? 600 : 400 }}>{v}</span>
  </div>
);

const Btn = ({ onClick, disabled, children }) => (
  <button onClick={onClick} disabled={disabled}
    className="w-full py-4 rounded-xl brand text-[12px] uppercase tracking-[0.18em] active:scale-[0.98] transition-transform"
    style={{ background: C.text, color: C.bg, fontWeight: 600, opacity: disabled ? 0.35 : 1 }}>{children}</button>
);

const Empty = ({ t, d }) => (
  <div className="rounded-xl p-5 text-center mb-3" style={{ background: C.chip }}>
    <div className="text-[13px] mb-1">{t}</div>
    <div className="say text-[12px]" style={{ color: C.ash }}>{d}</div>
  </div>
);

const Step = ({ n: num, t, c }) => (
  <div className="flex-1">
    <div className="num text-[10px]" style={{ color: c }}>{num}</div>
    <div className="text-[11px] leading-tight mt-0.5">{t}</div>
  </div>
);

const Pick = ({ opts, v, on, sfx = "" }) => (
  <select value={v} onChange={(e) => on(isNaN(+e.target.value) ? e.target.value : +e.target.value)}
    className="say rounded-md px-2 py-0.5 outline-none cursor-pointer"
    style={{ background: C.chip, color: C.amber, border: `1px solid ${C.edge}`, fontSize: "inherit" }}>
    {opts.map((o) => <option key={o} value={o} style={{ background: C.panel }}>{o}{sfx}</option>)}
  </select>
);

const Slide = ({ l, v, min, max, step = 1, val, set, help }) => (
  <div className="mb-5">
    <div className="flex justify-between mb-1.5 text-[12px]">
      <span style={{ color: C.ash }}>{l}</span><span className="num">{v}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={val}
      onChange={(e) => set(Number(e.target.value))} className="w-full cursor-pointer" />
    {help && <div className="say text-[12px] leading-relaxed mt-1.5" style={{ color: C.ash }}>{help}</div>}
  </div>
);

function AmountBox({ v, on, of }) {
  const num = Number(v) || 0;
  return (
    <div className="mb-4">
      <div className="flex items-center rounded-xl px-4 py-3" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
        <input inputMode="decimal" value={n(num)}
          onChange={(e) => on(String(Number(e.target.value.replace(/\D/g, "")) || 0))}
          className="flex-1 bg-transparent outline-none text-[19px] num" style={{ color: C.text }} />
        <span className="text-[13px]" style={{ color: C.ash }}>PLS</span>
      </div>
      {of > 0 && <div className="text-[10px] mt-1.5" style={{ color: num > of ? C.bad : C.ash }}>
        {num > of ? "More than your vault holds" : `${((num / of) * 100).toFixed(1)}% of vault`}
      </div>}
    </div>
  );
}
