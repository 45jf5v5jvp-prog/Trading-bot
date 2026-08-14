import React, { useState } from "react";

/**
 * bots.icaria.pro landing page.
 *
 * Design decisions worth keeping:
 *
 * 1. The hero is the product, not a picture of it. The whole personality of
 *    this thing is "write a plain sentence, a machine executes it", so the
 *    first thing you touch is an editable sentence.
 *
 * 2. Serif for the parts that talk to you, sans with tabular figures for the
 *    parts the machine handles. Every other crypto landing page is sans
 *    throughout and reads like a pitch deck. This reads like it is telling you
 *    something true.
 *
 * 3. The cost explainer is a feature, not a disclaimer. It sits above the fold
 *    of the second screen and shows exactly how much of a move the fees eat.
 *    Nobody else in this category does that, which is precisely why it works.
 */

const C = {
  bg: "#0B0B0D",
  panel: "#121215",
  edge: "#26262B",
  chip: "#1B1B1F",
  text: "#F5F3EF",
  ash: "#8A8B94",
  amber: "#C98A3E",
  glow: "#7A4E1E",
  good: "#4FBF8B",
  bad: "#E5484D",
};

const PULSEX_ROUND = 0.58;
const ICARIA_ROUND = 0.30;
const FEES = PULSEX_ROUND + ICARIA_ROUND; // 0.88%

function Sun({ size = 30, color = C.text }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill={color} aria-label="Icaria">
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

export default function Landing() {
  const [token, setToken] = useState("INC");
  const [dir, setDir] = useState("drops");
  const [thresh, setThresh] = useState(5);
  const [look, setLook] = useState(24);
  const [alloc, setAlloc] = useState(10);
  const [demoMove, setDemoMove] = useState(5);

  const kept = demoMove - FEES;
  const viable = kept > 0.6;

  return (
    <div className="min-h-screen w-full" style={{ background: C.bg, color: C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@600;800&family=Newsreader:opsz,wght@6..72,300;6..72,400;6..72,500&display=swap');
        .brand{font-family:'Montserrat',system-ui,sans-serif}
        .say{font-family:'Newsreader',Georgia,serif}
        .ui{font-family:ui-sans-serif,system-ui,sans-serif}
        .num{font-family:ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
        input[type=range]{accent-color:${C.amber}}
        a{color:inherit}
      `}</style>

      {/* nav */}
      <nav className="max-w-3xl mx-auto px-6 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Sun size={26} />
          <span className="brand text-[17px] tracking-[0.14em]" style={{ fontWeight: 800 }}>ICARIA</span>
        </div>
        <div className="ui flex gap-5 text-[12px]" style={{ color: C.ash }}>
          <a href="https://forge.icaria.pro">Forge</a>
          <a href="https://icaria.pro">Icaria</a>
        </div>
      </nav>

      {/* hero: the product itself, editable */}
      <header className="relative max-w-3xl mx-auto px-6 pt-10 pb-16">
        <div className="absolute inset-x-0 top-0 h-96 pointer-events-none -z-10"
          style={{ background: `radial-gradient(ellipse at 50% 0%, ${C.glow}44, transparent 60%)` }} />

        <h1 className="say text-[42px] sm:text-[54px] leading-[1.05] mb-4" style={{ fontWeight: 300 }}>
          Write a sentence.<br />
          <span style={{ color: C.amber }}>Icaria trades it.</span>
        </h1>
        <p className="say text-[17px] leading-relaxed mb-9 max-w-lg" style={{ color: C.ash, fontWeight: 300 }}>
          Automated trading on PulseChain without writing a line of code. Set the
          rule in plain English. Change it whenever you like.
        </p>

        <div className="rounded-2xl p-6 mb-4" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
          <div className="ui text-[10px] uppercase tracking-[0.2em] mb-4" style={{ color: C.ash }}>
            Try it
          </div>
          <div className="say text-[21px] sm:text-[24px] leading-loose" style={{ fontWeight: 300 }}>
            When <Pick opts={["PLS", "PLSX", "HEX", "INC"]} v={token} on={setToken} />{" "}
            <Pick opts={["drops", "rises"]} v={dir} on={setDir} />{" "}
            <Pick opts={[2, 3, 5, 8, 10, 15, 20]} v={thresh} on={setThresh} sfx="%" />{" "}
            from its <Pick opts={[1, 4, 12, 24, 72]} v={look} on={setLook} sfx="h" />{" "}
            {dir === "drops" ? "high" : "low"}, buy{" "}
            <Pick opts={[5, 10, 15, 25, 50]} v={alloc} on={setAlloc} sfx="%" /> of my funds.
          </div>
        </div>

        <div className="rounded-xl px-5 py-4 mb-8 flex items-start gap-3"
          style={{ background: thresh < 1.5 ? "#2A1012" : C.chip }}>
          <span className="text-[15px] mt-0.5" style={{ color: thresh < 1.5 ? C.bad : C.good }}>
            {thresh < 1.5 ? "!" : "✓"}
          </span>
          <p className="say text-[14px] leading-relaxed" style={{ color: thresh < 1.5 ? C.bad : C.ash }}>
            {thresh < 1.5
              ? `A ${thresh}% move does not cover the ${FEES}% it costs to buy and sell. This rule would lose money every time it fired.`
              : `A ${thresh}% move clears the ${FEES}% round-trip cost with ${(thresh - FEES).toFixed(2)}% left over. We show you this before you start, not after.`}
          </p>
        </div>

        <a href="#start" className="ui inline-block px-7 py-3.5 rounded-xl text-[13px] uppercase tracking-[0.18em]"
          style={{ background: C.text, color: C.bg, fontWeight: 600 }}>
          Start a bot
        </a>
      </header>

      {/* the two bots */}
      <Section label="Two bots">
        <div className="grid sm:grid-cols-2 gap-4">
          <Card
            title="Trading Bot"
            lead="The everyday one."
            body="Watches any token on PulseX and acts on your rule. Buy dips, take profits, average in. It can trade several times a day when a market moves enough to be worth it, or sit still for a week when it doesn't."
            points={["Any token with a PulseX pair", "Your rule, your wording", "Runs until you stop it"]}
          />
          <Card
            title="Launch Bot"
            lead="For new tokens."
            body="Buys the moment a token opens on PulseX, after checking it can actually be sold again. Set a price target and it takes profit for you, or leave the target off and simply hold what it bought."
            points={["Screens every token before buying", "Sell at your target, or just hold", "Daily spending cap"]}
          />
        </div>
      </Section>

      {/* SIGNATURE: costs, shown rather than buried */}
      <Section label="What it costs">
        <p className="say text-[17px] leading-relaxed mb-7 max-w-lg" style={{ color: C.ash, fontWeight: 300 }}>
          Every trade has a cost, and most trading tools bury it. Here it is.
          Drag the bar and watch how much of a price move the fees actually take.
        </p>

        <div className="rounded-2xl p-6" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
          <div className="flex justify-between items-baseline mb-3">
            <span className="ui text-[12px]" style={{ color: C.ash }}>Price moves in your favour by</span>
            <span className="num text-[19px]">{demoMove.toFixed(1)}%</span>
          </div>
          <input type="range" min={0.2} max={12} step={0.1} value={demoMove}
            onChange={(e) => setDemoMove(Number(e.target.value))} className="w-full cursor-pointer mb-6" />

          <div className="flex h-11 rounded-lg overflow-hidden mb-3" style={{ background: C.chip }}>
            <div className="flex items-center justify-center transition-all"
              style={{ width: `${Math.min(100, (PULSEX_ROUND / Math.max(demoMove, FEES)) * 100)}%`, background: "#4A2020" }}>
              <span className="num text-[10px] whitespace-nowrap px-1" style={{ color: C.bad }}>PulseX</span>
            </div>
            <div className="flex items-center justify-center transition-all"
              style={{ width: `${Math.min(100, (ICARIA_ROUND / Math.max(demoMove, FEES)) * 100)}%`, background: "#5A3A18" }}>
              <span className="num text-[10px] whitespace-nowrap px-1" style={{ color: C.amber }}>Us</span>
            </div>
            <div className="flex items-center justify-end px-3 transition-all"
              style={{ width: `${Math.max(0, (kept / Math.max(demoMove, FEES)) * 100)}%`,
                background: viable ? "#123527" : "transparent" }}>
              {viable && <span className="num text-[11px] whitespace-nowrap" style={{ color: C.good }}>
                {kept.toFixed(2)}% yours
              </span>}
            </div>
          </div>

          <Line l="PulseX swap fee, both ways" v={`${PULSEX_ROUND}%`} />
          <Line l="Icaria fee, both ways" v={`${ICARIA_ROUND}%`} c={C.amber} />
          <div className="h-px my-2" style={{ background: C.edge }} />
          <Line l="You keep" v={viable ? `${kept.toFixed(2)}%` : "nothing"} c={viable ? C.good : C.bad} strong />

          <p className="say text-[13px] leading-relaxed mt-5" style={{ color: C.ash }}>
            Two things this bar leaves out. On a shallow pool your own order nudges
            the price, which costs another 0.5% to 4%. And some tokens take a cut
            on every transfer, which we measure and show you before you trade them.
            Both make the green slice smaller.
          </p>
        </div>
      </Section>

      {/* custody */}
      <Section label="Your money stays yours">
        <div className="say text-[17px] leading-relaxed max-w-lg" style={{ color: C.ash, fontWeight: 300 }}>
          <p className="mb-4">
            Think of your wallet as your house, and your Icaria vault as a lockbox
            you put on the porch. You hold the only key that opens it.
          </p>
          <p className="mb-4">
            The bot has a different key. It does exactly one thing: take money from
            the lockbox to the exchange, buy or sell, and put the result straight
            back in the lockbox. Every time. That key cannot open the lockbox and
            carry anything away.
          </p>
          <p style={{ color: C.text }}>
            We never hold your tokens. You can empty the lockbox in one tap without
            asking us, and you can take the bot's key away even if our servers are
            switched off.
          </p>
        </div>
      </Section>

      {/* steps */}
      <Section label="Getting started">
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            ["Connect", "Your usual wallet on PulseChain. Takes a few seconds."],
            ["Fund", "Move any amount of PLS into your vault. Take it back whenever."],
            ["Set a rule", "Pick your words, check the numbers, start the bot."],
          ].map(([t, d], i) => (
            <div key={t} className="rounded-xl p-5" style={{ background: C.panel }}>
              <div className="num text-[11px] mb-2" style={{ color: C.amber }}>0{i + 1}</div>
              <div className="brand text-[13px] uppercase tracking-wider mb-2" style={{ fontWeight: 600 }}>{t}</div>
              <div className="say text-[14px] leading-relaxed" style={{ color: C.ash }}>{d}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* honest limits */}
      <Section label="What it won't do">
        <div className="say text-[15px] leading-relaxed max-w-lg space-y-3" style={{ color: C.ash, fontWeight: 300 }}>
          <p>It won't pick a strategy for you. You write the rule, we run it.</p>
          <p>
            It won't make a bad rule profitable. Buying every dip works in a sideways
            market and loses steadily in a falling one. We show you where your rule
            would have fired historically so you can judge for yourself.
          </p>
          <p>
            It won't make new tokens safe. We check that a token can be sold before
            buying it, and most fail that check. Some still turn hostile afterwards.
            Only put in what you can afford to lose entirely.
          </p>
        </div>
      </Section>

      <div id="start" className="max-w-3xl mx-auto px-6 py-16 text-center">
        <div className="flex justify-center mb-5"><Sun size={40} color={C.amber} /></div>
        <h2 className="say text-[30px] leading-tight mb-6" style={{ fontWeight: 300 }}>
          Set your first rule in about a minute.
        </h2>
        <button className="ui px-8 py-4 rounded-xl text-[13px] uppercase tracking-[0.18em]"
          style={{ background: C.text, color: C.bg, fontWeight: 600 }}>
          Connect wallet
        </button>
      </div>

      <footer className="max-w-3xl mx-auto px-6 py-8 ui text-[11px] leading-relaxed"
        style={{ color: C.ash, borderTop: `1px solid ${C.edge}` }}>
        Icaria Bots runs on PulseChain and PulseX. Trading digital assets carries
        risk and you can lose everything you put in. Nothing here is financial
        advice, and Icaria does not choose or recommend strategies.
        <div className="mt-3">© {new Date().getFullYear()} ICARIA</div>
      </footer>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <section className="max-w-3xl mx-auto px-6 py-12" style={{ borderTop: `1px solid ${C.edge}` }}>
      <div className="brand text-[10px] uppercase tracking-[0.24em] mb-6" style={{ color: C.amber, fontWeight: 600 }}>
        {label}
      </div>
      {children}
    </section>
  );
}

function Card({ title, lead, body, points }) {
  return (
    <div className="rounded-2xl p-6" style={{ background: C.panel, border: `1px solid ${C.edge}` }}>
      <div className="brand text-[16px] uppercase tracking-wide mb-1" style={{ fontWeight: 600 }}>{title}</div>
      <div className="say text-[14px] mb-4" style={{ color: C.amber }}>{lead}</div>
      <p className="say text-[15px] leading-relaxed mb-5" style={{ color: C.ash, fontWeight: 300 }}>{body}</p>
      {points.map((p) => (
        <div key={p} className="flex gap-2.5 items-start mb-2">
          <span className="text-[11px] mt-1" style={{ color: C.good }}>✓</span>
          <span className="ui text-[12px]" style={{ color: C.ash }}>{p}</span>
        </div>
      ))}
    </div>
  );
}

function Pick({ opts, v, on, sfx = "" }) {
  return (
    <select value={v} onChange={(e) => on(isNaN(+e.target.value) ? e.target.value : +e.target.value)}
      className="say rounded-md px-2 py-0.5 outline-none cursor-pointer"
      style={{ background: C.chip, color: C.amber, border: `1px solid ${C.edge}`, fontSize: "inherit" }}>
      {opts.map((o) => <option key={o} value={o} style={{ background: C.panel }}>{o}{sfx}</option>)}
    </select>
  );
}

function Line({ l, v, c, strong }) {
  return (
    <div className="flex justify-between py-1">
      <span className="ui text-[12px]" style={{ color: C.ash }}>{l}</span>
      <span className="num text-[12px]" style={{ color: c || C.text, fontWeight: strong ? 600 : 400 }}>{v}</span>
    </div>
  );
}
