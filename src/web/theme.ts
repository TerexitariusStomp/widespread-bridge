// theme.ts — Widespread design tokens + base CSS.
//
// Direction: "the clearing ledger" — deep ink surfaces, bone text, a single
// receipt-gold signal, phosphor green for settled work. Display serif for
// headlines (Instrument Serif), grotesk for UI (Archivo), mono for data
// (IBM Plex Mono). Hand-rolled — no framework, no build step, free-tier safe.
// Motion lives in fx.ts; everything here respects prefers-reduced-motion.

export const CSS = `
:root {
  --bg: #0a0b0e; --bg-raise: #101218; --bg-sunken: #06070a;
  --border: rgba(236,231,221,.10); --border-soft: rgba(236,231,221,.06);
  --fg: #ece7dd; --fg-dim: #a39c8e; --fg-faint: #6b655a;
  --gold: #f0b429; --gold-hi: #ffd166; --gold-dim: rgba(240,180,41,.35);
  --green: #2ea043; --green-hi: #3fb950; --green-glow: rgba(63,185,80,.35);
  --blue: #58a6ff; --red: #f85149; --amber: #d29922;
  --purple: #bc8cff; --teal: #39d0c0;
  --radius: 14px; --radius-sm: 8px;
  --serif: "Instrument Serif", Georgia, "Times New Roman", serif;
  --sans: "Archivo", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --maxw: 1180px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f4f1ea; --bg-raise: #fffdf8; --bg-sunken: #ece8de;
    --border: rgba(20,18,12,.14); --border-soft: rgba(20,18,12,.08);
    --fg: #1c1a14; --fg-dim: #5c574a; --fg-faint: #8a8474;
    --gold: #a86e00; --gold-hi: #8a5a00; --gold-dim: rgba(168,110,0,.3);
    --green: #1a7f37; --green-hi: #116329; --green-glow: rgba(17,99,41,.25);
    --blue: #0969da; --red: #cf222e; --amber: #9a6700;
    --purple: #8250df; --teal: #0e7c7b;
  }
}
* { box-sizing: border-box; }
html { color-scheme: dark light; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 var(--sans); -webkit-font-smoothing: antialiased;
  font-feature-settings: "ss01", "cv11"; }
::selection { background: var(--gold); color: #0a0b0e; }
a { color: var(--gold-hi); text-decoration: none; transition: color .15s ease; }
a:hover { color: var(--gold); }
code, .mono, pre { font-family: var(--mono); }
code { font-size: .9em; }
h1,h2,h3,h4 { line-height: 1.15; margin: 0 0 .5em; letter-spacing: -.01em; }
h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; } h3 { font-size: 1.02rem; }
p { margin: 0 0 .8em; }
.mut { color: var(--fg-dim); } .faint { color: var(--fg-faint); }
.small { font-size: .85rem; }

/* ---- film grain overlay (pure CSS, cheap) ---- */
body::after { content: ""; position: fixed; inset: 0; z-index: 60;
  pointer-events: none; opacity: .05; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E"); }

/* ---- shell ---- */
.topbar { border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  position: sticky; top: 0; z-index: 50; }
.topbar-inner { max-width: var(--maxw); margin: 0 auto; padding: 0 24px;
  display: flex; align-items: center; gap: 22px; height: 62px; }
.brand { font-family: var(--serif); font-weight: 400; font-size: 1.45rem;
  color: var(--fg); letter-spacing: -.01em; display: flex; align-items: baseline;
  gap: 7px; }
.brand:hover { text-decoration: none; }
.brand .dot { color: var(--gold); font-style: italic; }
.brand small { font-family: var(--mono); font-weight: 400; color: var(--fg-faint);
  font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
nav.main { display: flex; gap: 2px; margin-left: 10px; }
nav.main a { color: var(--fg-dim); padding: 7px 12px; border-radius: 999px;
  font-size: .82rem; font-weight: 600; letter-spacing: .01em; position: relative; }
nav.main a:hover { color: var(--fg); background: var(--bg-raise); text-decoration: none; }
nav.main a.active { color: var(--gold-hi); }
nav.main a.active::after { content: ""; position: absolute; left: 12px; right: 12px;
  bottom: 2px; height: 1px; background: var(--gold); }
.topbar .spacer { flex: 1; }
.topbar .feed-link { font-family: var(--mono); font-size: .72rem; color: var(--fg-faint);
  letter-spacing: .04em; }
main { max-width: var(--maxw); margin: 0 auto; padding: 0 24px 96px; }
footer { border-top: 1px solid var(--border); padding: 30px 24px 48px;
  color: var(--fg-faint); font-size: .8rem; }
footer .inner { max-width: var(--maxw); margin: 0 auto; display: flex;
  gap: 20px; flex-wrap: wrap; align-items: center; }
footer a { color: var(--fg-dim); font-family: var(--mono); font-size: .76rem; }
footer a:hover { color: var(--gold-hi); }

/* ---- hero (home) ---- */
.hero { position: relative; margin: 0 -24px; padding: 0; overflow: hidden; }
#fx-hero { position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; }
.hero-scrim { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg) 30%, transparent) 0%,
    color-mix(in srgb, var(--bg) 78%, transparent) 62%, var(--bg) 100%); }
.hero-inner { position: relative; z-index: 2; max-width: var(--maxw);
  margin: 0 auto; padding: 110px 24px 90px; }
.kicker { font-family: var(--mono); font-size: .72rem; letter-spacing: .22em;
  text-transform: uppercase; color: var(--gold); margin-bottom: 22px;
  display: flex; align-items: center; gap: 12px; }
.kicker::before { content: ""; width: 34px; height: 1px; background: var(--gold); }
.hero h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(3rem, 8.5vw, 6.4rem);
  line-height: .98; letter-spacing: -.025em; margin: 0 0 26px; max-width: 15ch; }
.hero h1 em { font-style: italic; color: var(--gold-hi);
  background: linear-gradient(100deg, var(--gold) 10%, var(--gold-hi) 45%, var(--teal) 90%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.hero p.lede { font-size: 1.18rem; color: var(--fg-dim); max-width: 560px;
  margin-bottom: 34px; }
.hero p.lede b { color: var(--fg); font-weight: 600; }

/* ---- ticker ---- */
.ticker { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  overflow: hidden; padding: 13px 0; background: color-mix(in srgb, var(--bg-raise) 55%, transparent); }
.ticker-track { display: flex; gap: 0; width: max-content; animation: tick 46s linear infinite; }
.ticker:hover .ticker-track { animation-play-state: paused; }
@keyframes tick { to { transform: translateX(-50%); } }
.tick-item { display: inline-flex; align-items: center; gap: 10px; padding: 0 26px;
  font-family: var(--mono); font-size: .74rem; letter-spacing: .1em;
  text-transform: uppercase; color: var(--fg-faint); white-space: nowrap; }
.tick-item i { font-style: normal; color: var(--gold); }
.tick-item b { color: var(--fg-dim); font-weight: 500; }

/* ---- sections ---- */
section.block { margin-top: 76px; }
.block-head { display: flex; align-items: baseline; gap: 18px; margin-bottom: 26px; }
.block-head .idx { font-family: var(--mono); font-size: .74rem; color: var(--gold);
  letter-spacing: .15em; }
.block-head h2 { font-family: var(--serif); font-weight: 400; font-size: 2.3rem;
  letter-spacing: -.02em; margin: 0; }
.block-head .rule { flex: 1; height: 1px; background: var(--border); }
.block-head .hint { font-family: var(--mono); font-size: .72rem; color: var(--fg-faint);
  letter-spacing: .08em; text-transform: uppercase; }

/* ---- stat counters ---- */
.stat-row { display: flex; gap: 0; flex-wrap: wrap; margin: 44px 0 0;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.stat { padding: 26px 40px 26px 0; margin-right: 40px;
  border-right: 1px solid var(--border-soft); }
.stat:last-child { border-right: 0; }
.stat .n { font-family: var(--mono); font-size: 2.1rem; font-weight: 500;
  color: var(--fg); letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.stat .l { font-family: var(--mono); font-size: .7rem; color: var(--fg-faint);
  text-transform: uppercase; letter-spacing: .14em; margin-top: 4px; }
.stat .n em { font-style: normal; color: var(--gold); font-size: .55em; }

/* ---- cards / layout ---- */
.card { background: color-mix(in srgb, var(--bg-raise) 80%, transparent);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 22px 24px; margin-bottom: 16px; position: relative; }
.card::before { content: ""; position: absolute; inset: 0; border-radius: inherit;
  background: radial-gradient(600px circle at var(--mx, 50%) var(--my, 0%),
    rgba(240,180,41,.05), transparent 45%); opacity: 0; transition: opacity .3s; }
.card:hover::before { opacity: 1; }
.card.flat { background: transparent; border-color: var(--border-soft); }
.grid { display: grid; gap: 16px; }
.grid.cols-2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.grid.cols-3 { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.jury-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.jury-seat { border: 1px solid var(--border-soft); border-radius: var(--radius-sm);
  padding: 14px 16px; display: flex; flex-direction: column; gap: 4px;
  background: color-mix(in srgb, var(--bg-sunken) 60%, transparent); }
.jury-seat .pill { align-self: flex-start; margin-top: 6px; }
.tbl { width: 100%; border-collapse: collapse; font-size: .88rem; }
.tbl th { text-align: left; color: var(--fg-faint); font-family: var(--mono);
  font-size: .68rem; text-transform: uppercase; letter-spacing: .1em;
  padding: 6px 12px 8px 0; border-bottom: 1px solid var(--border); }
.tbl td { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--border-soft);
  vertical-align: top; }
.tbl tr:last-child td { border-bottom: none; }
.spread { display: flex; justify-content: space-between; gap: 14px;
  padding: 9px 0; border-bottom: 1px solid var(--border-soft); }
.spread:last-child { border-bottom: 0; }
.spread .k { color: var(--fg-dim); font-size: .85rem; }
.spread .v { font-weight: 600; text-align: right; }

/* ---- pills / badges ---- */
.pill { display: inline-flex; align-items: center; gap: 6px;
  border-radius: 999px; padding: 3px 12px; font-family: var(--mono);
  font-size: .7rem; font-weight: 500; letter-spacing: .05em;
  text-transform: uppercase; white-space: nowrap; border: 1px solid transparent; }
.pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: currentColor; opacity: .8; }
.pill.ok   { background: rgba(63,185,80,.1);   color: var(--green-hi); border-color: rgba(63,185,80,.35); }
.pill.bad  { background: rgba(248,81,73,.1);   color: var(--red);      border-color: rgba(248,81,73,.35); }
.pill.warn { background: rgba(210,153,34,.1);  color: var(--amber);    border-color: rgba(210,153,34,.35); }
.pill.info { background: rgba(88,166,255,.1);  color: var(--blue);     border-color: rgba(88,166,255,.35); }
.pill.mut  { background: rgba(139,148,158,.1); color: var(--fg-dim);   border-color: var(--border); }
.pill.gold { background: rgba(240,180,41,.12); color: var(--gold-hi);  border-color: var(--gold-dim); }
.forge-badge { display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 3px 10px; font-family: var(--mono); font-size: .68rem; font-weight: 500;
  color: var(--fg-dim); text-transform: uppercase; letter-spacing: .08em; }

/* ---- bounty cards ---- */
.bounty-card { display: flex; flex-direction: column; gap: 0; color: var(--fg);
  position: relative; overflow: hidden; transition: transform .25s cubic-bezier(.2,.8,.2,1),
    border-color .25s ease, box-shadow .25s ease; }
.bounty-card::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; background: linear-gradient(180deg, var(--gold), transparent);
  opacity: 0; transition: opacity .25s; }
.bounty-card:hover { text-decoration: none; border-color: var(--gold-dim);
  transform: translateY(-3px); box-shadow: 0 18px 40px -18px rgba(0,0,0,.6); }
.bounty-card:hover::after { opacity: 1; }
.bounty-card .title { font-weight: 600; font-size: 1.02rem; margin-bottom: 5px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: box;
  overflow: hidden; letter-spacing: -.01em; }
.bounty-card:hover .title { color: var(--gold-hi); }
.bounty-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  font-size: .78rem; color: var(--fg-dim); margin-bottom: 12px; }
.bounty-foot { display: flex; align-items: flex-end; justify-content: space-between;
  gap: 12px; margin-top: auto; padding-top: 14px; }
.amount { font-family: var(--mono); font-size: 1.4rem; font-weight: 500;
  color: var(--green-hi); letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.amount small { font-family: var(--sans); font-size: .78rem; font-weight: 600;
  color: var(--fg-dim); }
.amount .cut { font-size: .75rem; font-weight: 400; color: var(--fg-faint);
  font-family: var(--sans); }
.stats-line { display: flex; gap: 14px; font-size: .76rem; color: var(--fg-faint);
  border-top: 1px solid var(--border-soft); padding-top: 10px; margin-top: 6px; }
.stats-line b { color: var(--fg-dim); font-weight: 600; }
.sigil { width: 46px; height: 46px; border-radius: 10px; flex: none;
  border: 1px solid var(--border-soft); background: var(--bg-sunken); }

/* ---- manifesto statement ---- */
.statement { font-family: var(--serif); font-style: italic; font-weight: 400;
  font-size: clamp(1.9rem, 4.6vw, 3.4rem); line-height: 1.12; letter-spacing: -.015em;
  color: var(--fg); margin: 8px 0 0; max-width: 20ch; }
.statement::first-letter { color: var(--gold-hi); }

/* ---- CTA band ---- */
.cta-band { text-align: center; padding: 64px 32px;
  border: 1px solid var(--border); border-radius: 22px; position: relative;
  overflow: hidden;
  background:
    radial-gradient(700px 300px at 50% 120%, rgba(240,180,41,.12), transparent 65%),
    color-mix(in srgb, var(--bg-raise) 60%, transparent); }
.cta-band::before { content: ""; position: absolute; inset: -1px;
  border-radius: inherit; padding: 1px;
  background: linear-gradient(140deg, var(--gold-dim), transparent 40%, transparent 60%, var(--gold-dim));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  pointer-events: none; opacity: .6; }
.cta-band h2 { font-family: var(--serif); font-weight: 400; font-size: clamp(2.2rem, 5.5vw, 3.8rem);
  letter-spacing: -.025em; margin: 14px 0 12px; }
.cta-band .kicker { justify-content: center; }
.cta-band .kicker::after { content: ""; width: 34px; height: 1px; background: var(--gold); }
.cta-band p { max-width: 520px; margin: 0 auto 8px; }

/* ---- receipt ledger rows (home proof section) ---- */
.receipt-row { display: flex; align-items: center; gap: 14px;
  padding: 13px 16px; border-bottom: 1px solid var(--border-soft);
  color: var(--fg); transition: background .15s; }
.receipt-row:last-child { border-bottom: 0; }
.receipt-row:hover { background: var(--bg-raise); text-decoration: none; }
.receipt-row .rr-repo { font-weight: 600; font-size: .92rem; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.receipt-row .rr-meta { margin-left: auto; display: flex; gap: 14px;
  align-items: center; color: var(--fg-faint); font-size: .76rem;
  font-family: var(--mono); white-space: nowrap; }
.receipt-row:hover .rr-repo { color: var(--gold-hi); }

/* ---- detail / spec ---- */
details.spec { border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-sunken) 70%, transparent); margin: 12px 0; }
details.spec summary { cursor: pointer; padding: 12px 16px; font-family: var(--mono);
  font-size: .78rem; font-weight: 500; color: var(--fg-dim); list-style: none;
  letter-spacing: .05em; text-transform: uppercase; }
details.spec summary::before { content: "▸ "; color: var(--gold); }
details.spec[open] summary::before { content: "▾ "; }
details.spec .body { padding: 2px 16px 16px; font-size: .88rem;
  white-space: pre-wrap; word-break: break-word; color: var(--fg-dim); }
.kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr));
  gap: 2px 26px; }
.case-no { font-family: var(--mono); font-size: .72rem; letter-spacing: .18em;
  text-transform: uppercase; color: var(--gold); }

/* ---- buttons / forms ---- */
.btn { display: inline-flex; align-items: center; gap: 8px;
  background: var(--gold); color: #141310; border: 1px solid var(--gold);
  border-radius: 999px; padding: 11px 22px; font-size: .88rem;
  font-weight: 700; letter-spacing: .01em; cursor: pointer;
  transition: transform .15s ease, box-shadow .15s ease, filter .15s; }
.btn:hover { background: var(--gold-hi); border-color: var(--gold-hi);
  text-decoration: none; transform: translateY(-1px);
  box-shadow: 0 8px 24px -8px var(--gold-dim); }
.btn.gold { background: var(--gold); border-color: var(--gold); color: #141310; }
.btn.ghost { background: transparent; color: var(--fg);
  border-color: var(--border); }
.btn.ghost:hover { border-color: var(--fg-dim); background: var(--bg-raise);
  box-shadow: none; }
.btn.sm { padding: 6px 14px; font-size: .8rem; }
input[type=text], input[type=search], select {
  background: var(--bg-sunken); border: 1px solid var(--border);
  color: var(--fg); border-radius: var(--radius-sm); padding: 10px 14px;
  font-size: .88rem; font-family: var(--sans); transition: border-color .15s; }
input[type=text]:focus, input[type=search]:focus, select:focus {
  outline: none; border-color: var(--gold-dim); }
input[type=search] { min-width: 240px; }
input::placeholder { color: var(--fg-faint); }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  margin-bottom: 22px; padding: 14px 16px;
  background: color-mix(in srgb, var(--bg-raise) 70%, transparent);
  border: 1px solid var(--border); border-radius: var(--radius); }
.toolbar .spacer { flex: 1; }

/* ---- receipt / signature ---- */
.sig-block { background: var(--bg-sunken); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px 16px; font-size: .76rem;
  font-family: var(--mono); word-break: break-all; color: var(--fg-dim);
  white-space: pre-wrap; }
.timeline { border-left: 1px solid var(--border); margin-left: 10px; padding-left: 22px; }
.timeline .ev { position: relative; padding: 0 0 18px 4px; }
.timeline .ev::before { content: ""; position: absolute; left: -26px; top: 6px;
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--bg); border: 2px solid var(--gold); }
.timeline .ev:last-child::before { border-color: var(--green-hi); }
.timeline .ev .t { font-family: var(--mono); font-size: .72rem; color: var(--fg-faint);
  letter-spacing: .1em; text-transform: uppercase; }
.timeline .ev .d { font-size: .92rem; margin-top: 3px; }

/* ---- misc ---- */
.hero-static { padding: 60px 0 20px; }
.hero-static h1 { font-family: var(--serif); font-weight: 400;
  font-size: clamp(2.6rem, 7vw, 5rem); line-height: 1; letter-spacing: -.025em;
  margin-bottom: 18px; }
.hero-static h1 em { font-style: italic;
  background: linear-gradient(100deg, var(--gold), var(--gold-hi) 50%, var(--teal));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.hero-static p { font-size: 1.1rem; color: var(--fg-dim); max-width: 620px; }
.notice { border: 1px solid var(--gold-dim); background: rgba(240,180,41,.06);
  border-radius: var(--radius-sm); padding: 13px 18px; font-size: .86rem;
  color: var(--amber); margin: 18px 0; }
.empty { text-align: center; padding: 72px 20px; color: var(--fg-dim); }
.empty .big { font-family: var(--serif); font-size: 1.6rem; margin-bottom: 8px;
  color: var(--fg); }
code.inline { background: var(--bg-sunken); border: 1px solid var(--border-soft);
  border-radius: 4px; padding: 1px 7px; }
.page-head { padding: 44px 0 8px; }
.page-head h1 { font-family: var(--serif); font-weight: 400; font-size: 2.6rem;
  letter-spacing: -.025em; margin-bottom: 10px; }
.page-head h1 em { font-style: italic; color: var(--gold-hi); }
.page-head .sub { color: var(--fg-dim); font-size: 1.02rem; max-width: 640px; }
.step-num { font-family: var(--mono); font-size: .72rem; color: var(--gold);
  letter-spacing: .15em; }

/* ---- scroll reveals (fx.ts adds .in) ---- */
.reveal { opacity: 0; transform: translateY(26px);
  transition: opacity .8s cubic-bezier(.2,.7,.2,1), transform .8s cubic-bezier(.2,.7,.2,1); }
.reveal.in { opacity: 1; transform: none; }
.reveal-d1 { transition-delay: .08s; } .reveal-d2 { transition-delay: .16s; }
.reveal-d3 { transition-delay: .24s; }

.marks { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
.mark-item { display: inline-flex; align-items: center; gap: 9px;
  padding: 9px 15px; border: 1px solid var(--border-soft); border-radius: 999px;
  background: var(--bg-raise); color: var(--fg-dim); text-decoration: none;
  transition: border-color .18s, color .18s, transform .18s; }
.mark-item:hover { border-color: var(--gold-dim); color: var(--gold-hi);
  transform: translateY(-1px); }
.mark-item svg { height: 19px; width: auto; max-width: 76px; fill: currentColor; flex: none; }
.mark-item svg * { fill: currentColor; }
.mark-item .mark-name { font-size: .8rem; font-weight: 500; letter-spacing: .01em; }
.mark-note { margin-top: 14px; font-size: .74rem; color: var(--fg-faint);
  max-width: 640px; line-height: 1.5; }

@media (max-width: 640px) {
  .topbar-inner { gap: 12px; padding: 0 16px; }
  nav.main a { padding: 7px 9px; font-size: .78rem; }
  .topbar .feed-link { display: none; }
  main { padding: 0 16px 72px; }
  .hero-inner { padding: 72px 16px 64px; }
  .hero { margin: 0 -16px; }
  .hero-static h1, .page-head h1 { font-size: 2.1rem; }
  .stat-row { gap: 0; }
  .stat { padding: 20px 22px 20px 0; margin-right: 22px; }
  .stat .n { font-size: 1.5rem; }
  .jury-grid { grid-template-columns: 1fr; }
  .grid.cols-2, .grid.cols-3 { grid-template-columns: 1fr; }
  .tbl { display: block; overflow-x: auto; white-space: nowrap; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar .spacer { display: none; }
  input[type=search] { min-width: 0; width: 100%; }
  .ticker-track { animation-duration: 30s; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .reveal { opacity: 1; transform: none; transition: none; }
  .ticker-track { animation: none; }
  .bounty-card, .btn { transition: none; }
  .bounty-card:hover { transform: none; }
}
`;
