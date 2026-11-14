// theme.ts — Widespread design tokens + base CSS.
//
// Language borrowed from delta-git's PRODUCT.md direction: "precise,
// opinionated, utilitarian — with a gold edge." Dark-primary, gold brand
// accent, green primary action, Primer-derived surfaces. Hand-rolled —
// no framework, no build step, free-tier safe.

export const CSS = `
:root {
  --bg: #0d1117; --bg-raise: #161b22; --bg-sunken: #010409;
  --border: #30363d; --border-soft: #21262d;
  --fg: #e6edf3; --fg-dim: #8b949e; --fg-faint: #6e7681;
  --gold: #e3b341; --gold-dim: #9a6700;
  --green: #238636; --green-hi: #2ea043;
  --blue: #4493f8; --red: #f85149; --amber: #d29922;
  --purple: #bc8cff;
  --radius: 10px; --radius-sm: 6px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff; --bg-raise: #f6f8fa; --bg-sunken: #eff2f5;
    --border: #d0d7de; --border-soft: #e8ecf0;
    --fg: #1f2328; --fg-dim: #59636e; --fg-faint: #818b98;
    --gold: #9a6700; --gold-dim: #9a6700;
    --green: #1f883d; --green-hi: #1a7f37;
    --blue: #0969da; --red: #cf222e; --amber: #9a6700;
    --purple: #8250df;
  }
}
* { box-sizing: border-box; }
html { color-scheme: dark light; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: .92em; }
h1,h2,h3,h4 { line-height: 1.25; margin: 0 0 .5em; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; } h3 { font-size: 1rem; }
p { margin: 0 0 .8em; }
.mut { color: var(--fg-dim); } .faint { color: var(--fg-faint); }
.small { font-size: .85rem; }

/* ---- shell ---- */
.topbar { border-bottom: 1px solid var(--border); background: var(--bg-raise);
  position: sticky; top: 0; z-index: 10; }
.topbar-inner { max-width: 1080px; margin: 0 auto; padding: 0 20px;
  display: flex; align-items: center; gap: 18px; height: 56px; }
.brand { font-weight: 800; font-size: 1.05rem; color: var(--fg);
  letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; }
.brand:hover { text-decoration: none; }
.brand .dot { color: var(--gold); }
.brand small { font-weight: 500; color: var(--fg-dim); font-size: .8rem; }
nav.main { display: flex; gap: 4px; margin-left: 8px; }
nav.main a { color: var(--fg-dim); padding: 6px 10px; border-radius: var(--radius-sm);
  font-size: .9rem; font-weight: 600; }
nav.main a:hover { color: var(--fg); background: var(--bg-sunken);
  text-decoration: none; }
nav.main a.active { color: var(--gold); }
.topbar .spacer { flex: 1; }
.topbar .feed-link { font-size: .8rem; color: var(--fg-faint); }
main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }
footer { border-top: 1px solid var(--border); padding: 22px 20px 40px;
  color: var(--fg-faint); font-size: .82rem; }
footer .inner { max-width: 1080px; margin: 0 auto; display: flex;
  gap: 18px; flex-wrap: wrap; }

/* ---- cards / layout ---- */
.card { background: var(--bg-raise); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 18px 20px; margin-bottom: 16px; }
.card.flat { background: transparent; }
.grid { display: grid; gap: 14px; }
.grid.cols-2 { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.grid.cols-3 { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.jury-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.jury-seat { border: 1px solid var(--border-soft); border-radius: var(--radius-sm);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
.jury-seat .pill { align-self: flex-start; margin-top: 4px; }
.tbl { width: 100%; border-collapse: collapse; font-size: .88rem; }
.tbl th { text-align: left; color: var(--fg-faint); font-size: .72rem;
  text-transform: uppercase; letter-spacing: .04em; padding: 4px 10px 6px 0;
  border-bottom: 1px solid var(--border); }
.tbl td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--border-soft);
  vertical-align: top; }
.tbl tr:last-child td { border-bottom: none; }
.pill { display: inline-block; font-size: .72rem; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--fg-dim); }
.pill.ok { border-color: var(--green); color: var(--green-hi); }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.spread { display: flex; justify-content: space-between; gap: 12px;
  padding: 7px 0; border-bottom: 1px solid var(--border-soft); }
.spread:last-child { border-bottom: 0; }
.spread .k { color: var(--fg-dim); }
.spread .v { font-weight: 600; text-align: right; }

/* ---- pills / badges ---- */
.pill { display: inline-flex; align-items: center; gap: 5px;
  border-radius: 999px; padding: 2px 11px; font-size: .74rem;
  font-weight: 700; letter-spacing: .02em; white-space: nowrap;
  border: 1px solid transparent; }
.pill.ok   { background: rgba(46,160,67,.13);  color: var(--green-hi); border-color: rgba(46,160,67,.4); }
.pill.bad  { background: rgba(248,81,73,.12);  color: var(--red);      border-color: rgba(248,81,73,.4); }
.pill.warn { background: rgba(210,153,34,.12); color: var(--amber);    border-color: rgba(210,153,34,.4); }
.pill.info { background: rgba(68,147,248,.12); color: var(--blue);     border-color: rgba(68,147,248,.4); }
.pill.mut  { background: rgba(139,148,158,.12);color: var(--fg-dim);   border-color: var(--border); }
.pill.gold { background: rgba(227,179,65,.13); color: var(--gold);     border-color: rgba(227,179,65,.45); }
.forge-badge { display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 1px 8px; font-size: .72rem; font-weight: 700; color: var(--fg-dim);
  text-transform: uppercase; letter-spacing: .04em; }

/* ---- bounty cards ---- */
.bounty-card { display: block; color: var(--fg); }
.bounty-card:hover { text-decoration: none; border-color: var(--gold-dim); }
.bounty-card .title { font-weight: 650; font-size: 1rem; margin-bottom: 4px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: box;
  overflow: hidden; }
.bounty-card:hover .title { color: var(--gold); }
.bounty-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  font-size: .8rem; color: var(--fg-dim); margin-bottom: 10px; }
.amount { font-size: 1.35rem; font-weight: 800; color: var(--green-hi);
  font-family: var(--mono); letter-spacing: -.02em; }
.amount small { font-size: .8rem; font-weight: 600; color: var(--fg-dim); }
.amount .cut { font-size: .78rem; font-weight: 500; color: var(--fg-faint);
  font-family: var(--sans); }
.stats-line { display: flex; gap: 14px; font-size: .78rem; color: var(--fg-faint);
  border-top: 1px solid var(--border-soft); padding-top: 9px; margin-top: 4px; }
.stats-line b { color: var(--fg-dim); font-weight: 600; }

/* ---- detail / spec ---- */
details.spec { border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-sunken); margin: 10px 0; }
details.spec summary { cursor: pointer; padding: 10px 14px; font-size: .85rem;
  font-weight: 600; color: var(--fg-dim); list-style: none; }
details.spec summary::before { content: "▸ "; color: var(--gold); }
details.spec[open] summary::before { content: "▾ "; }
details.spec .body { padding: 4px 14px 14px; font-size: .88rem;
  white-space: pre-wrap; word-break: break-word; color: var(--fg-dim); }
.kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr));
  gap: 2px 24px; }

/* ---- buttons / forms ---- */
.btn { display: inline-flex; align-items: center; gap: 7px;
  background: var(--green); color: #fff; border: 1px solid var(--green);
  border-radius: var(--radius-sm); padding: 9px 18px; font-size: .9rem;
  font-weight: 700; cursor: pointer; }
.btn:hover { background: var(--green-hi); text-decoration: none; }
.btn.gold { background: var(--gold); border-color: var(--gold); color: #1f2328; }
.btn.gold:hover { filter: brightness(1.08); }
.btn.ghost { background: transparent; color: var(--fg);
  border-color: var(--border); }
.btn.ghost:hover { border-color: var(--fg-dim); background: var(--bg-sunken); }
.btn.sm { padding: 5px 12px; font-size: .82rem; }
input[type=text], input[type=search], select {
  background: var(--bg-sunken); border: 1px solid var(--border);
  color: var(--fg); border-radius: var(--radius-sm); padding: 8px 12px;
  font-size: .9rem; font-family: var(--sans); }
input[type=search] { min-width: 220px; }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  margin-bottom: 18px; }
.toolbar .spacer { flex: 1; }

/* ---- receipt / signature ---- */
.sig-block { background: var(--bg-sunken); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px 14px; font-size: .78rem;
  font-family: var(--mono); word-break: break-all; color: var(--fg-dim); }
.timeline { border-left: 2px solid var(--border); margin-left: 8px; padding-left: 18px; }
.timeline .ev { position: relative; padding: 0 0 14px 4px; }
.timeline .ev::before { content: ""; position: absolute; left: -23px; top: 5px;
  width: 9px; height: 9px; border-radius: 50%; background: var(--gold);
  border: 2px solid var(--bg); }
.timeline .ev .t { font-size: .78rem; color: var(--fg-faint); }
.timeline .ev .d { font-size: .9rem; }

/* ---- misc ---- */
.hero { padding: 34px 0 8px; }
.hero h1 { font-size: 2rem; letter-spacing: -.02em; margin-bottom: 10px; }
.hero h1 .gold { color: var(--gold); }
.hero p { font-size: 1.05rem; color: var(--fg-dim); max-width: 640px; }
.stat-row { display: flex; gap: 28px; flex-wrap: wrap; margin: 18px 0 4px; }
.stat .n { font-size: 1.6rem; font-weight: 800; font-family: var(--mono);
  color: var(--fg); }
.stat .l { font-size: .78rem; color: var(--fg-faint); text-transform: uppercase;
  letter-spacing: .05em; }
.notice { border: 1px solid rgba(210,153,34,.4); background: rgba(210,153,34,.07);
  border-radius: var(--radius-sm); padding: 10px 14px; font-size: .85rem;
  color: var(--amber); margin: 12px 0; }
.empty { text-align: center; padding: 48px 20px; color: var(--fg-dim); }
.empty .big { font-size: 1.1rem; margin-bottom: 6px; color: var(--fg); }
code.inline { background: var(--bg-sunken); border: 1px solid var(--border-soft);
  border-radius: 4px; padding: 1px 6px; }
@media (max-width: 640px) {
  .topbar-inner { gap: 10px; padding: 0 14px; }
  nav.main a { padding: 6px 7px; font-size: .82rem; }
  main { padding: 20px 14px 60px; }
  .hero h1 { font-size: 1.5rem; }
  .stat-row { gap: 16px; }
  .stat .n { font-size: 1.25rem; }
  .jury-grid { grid-template-columns: 1fr; }
  .grid.cols-2, .grid.cols-3 { grid-template-columns: 1fr; }
  .tbl { display: block; overflow-x: auto; white-space: nowrap; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar .spacer { display: none; }
}
@media (prefers-reduced-motion: no-preference) {
  .bounty-card { transition: border-color .15s ease; }
}
`;
