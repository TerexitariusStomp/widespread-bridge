// Single-file dashboard: claim → evidence → verdict → payout, all live.
// No build step — the Worker serves this HTML and the page polls /api/state.

export const OPS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Widespread · verified-work payouts</title>
<script src="https://cdn.jsdelivr.net/npm/ag-grid-community@33/dist/ag-grid-community.min.js"></script>
<style>
  :root { --pp-dark:#003087; --pp-blue:#0070e0; --bg:#0d1117; --card:#161b22;
    --border:#30363d; --fg:#e6edf3; --mut:#8b949e; --ok:#2ea043; --bad:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--border);
    display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  .near { background:#00ec97; color:#04141c; border-radius:6px;
    padding:3px 10px; font-weight:700; font-size:12px; letter-spacing:.3px; }
  .ai { border:1px solid var(--pp-blue); color:var(--pp-blue); border-radius:6px;
    padding:3px 10px; font-weight:600; font-size:12px; }
  header .mut { margin-left:auto; }
  main { padding:20px 24px; max-width:1100px; margin:0 auto; }
  .mut { color:var(--mut); font-size:12px; }
  .card { background:var(--card); border:1px solid var(--border);
    border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  .flow { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
    gap:10px; margin-top:12px; }
  .step { border:1px solid var(--border); border-radius:8px; padding:10px 12px;
    background:#0d1117; min-width:0; }
  .step h3 { margin:0 0 6px; font-size:11px; text-transform:uppercase;
    letter-spacing:.6px; color:var(--mut); }
  .step pre { margin:0; font-size:11px; white-space:pre-wrap; word-break:break-all;
    max-height:150px; overflow:auto; color:var(--mut); }
  .badge { display:inline-block; border-radius:20px; padding:1px 10px;
    font-size:11px; font-weight:700; }
  .b-ok { background:rgba(46,160,67,.15); color:var(--ok); border:1px solid var(--ok); }
  .b-bad { background:rgba(248,81,73,.15); color:var(--bad); border:1px solid var(--bad); }
  .b-mut { background:rgba(139,148,158,.15); color:var(--mut); border:1px solid var(--mut); }
  .b-pp { background:var(--pp-dark); color:#fff; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  a { color:var(--pp-blue); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  form { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 18px; }
  input,button { background:#0d1117; border:1px solid var(--border); color:var(--fg);
    border-radius:6px; padding:7px 10px; font-size:13px; }
  button { cursor:pointer; background:var(--pp-blue); border-color:var(--pp-blue);
    color:#fff; font-weight:600; }
  button.sec { background:transparent; color:var(--pp-blue); }
  h2 { font-size:14px; margin:22px 0 10px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td,th { border-bottom:1px solid var(--border); text-align:left; padding:7px 8px; }
  .kv { color:var(--mut); }
  .conf { height:6px; border-radius:3px; background:var(--border); overflow:hidden;
    margin-top:6px; }
  .conf i { display:block; height:100%; background:var(--pp-blue); }
  .grid { height:220px; margin-bottom:14px; }
  /* AG Grid dark theme tokens */
  .ag-theme-quartz-dark, .ag-theme-quartz {
    --ag-background-color: var(--card);
    --ag-header-background-color: #0d1117;
    --ag-foreground-color: var(--fg);
    --ag-border-color: var(--border);
    --ag-row-hover-color: #1c2128;
    --ag-font-size: 12px;
  }
</style>
</head>
<body>
<header>
  <div id="oplog-warn" style="display:none;padding:8px 12px;margin-bottom:12px;border:1px solid #d29922;border-radius:8px;color:#d29922;font-size:13px">⚠ forge op-log is empty — entries wipe periodically; run <code>node scripts/reseed-demo.mjs</code></div>
  <h1>Widespread <span class="mut">verified-work payouts</span></h1>
  <span class="near">NEAR escrow</span>
  <span class="ai">AI adjudicator</span>
  <span class="ai">AG Grid</span>
  <span class="mut" id="stamp"></span>
</header>
<main>
  <div class="mut">
    delta-git op-log claim → independent evidence → LLM verdict → NEAR
    market release to the winner's claimant account. Every row below is a
    live record — nothing is mocked.
  </div>

  <h2>Run a review</h2>
  <form onsubmit="return runReview(event)">
    <input id="f-repo" placeholder="owner/repo" value="slop/slopdotcash" size="22">
    <input id="f-seq" placeholder="op-log seq" size="8">
    <button type="submit">Review claim</button>
    <button type="button" class="sec" onclick="return runReview(event,true)">Review all outstanding</button>
    <span class="mut" id="run-out"></span>
  </form>

  <h2>Open bounties <input id="qfilter" placeholder="filter…" style="float:right;width:160px;padding:4px 8px" oninput="onFilter(this.value)"></h2>
  <div id="bounties-grid" class="grid"></div>

  <h2>Claim → payout receipts</h2>
  <div id="claims-grid" class="grid"></div>
  <div id="claims" class="mut">loading…</div>
</main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const badge = (t, cls) => \`<span class="badge \${cls}">\${esc(t)}</span>\`;
const fmt = (ms) => new Date(ms).toISOString().replace("T"," ").slice(0,19)+"Z";

function statusBadge(s) {
  if (s === "accepted_paid") return badge("ACCEPTED · PAID","b-ok");
  if (s === "accepted_unpaid") return badge("ACCEPTED · UNPAID","b-mut");
  if (s === "rejected") return badge("REJECTED","b-bad");
  return badge("ERROR","b-bad");
}

function claimCard(r) {
  const p = r.claim.payload || {};
  const pay = r.payout || {};
  const adj = r.adjudication || {};
  const chainOk = r.chain && r.chain.valid;
  const commits = (r.commits||[]).map(c =>
    \`  \${c.sha.slice(0,10)}  +\${c.lines_added}/-\${c.lines_removed}  \${(c.files||[]).length} files  [\${c.source}]\`).join("\\n");
  const firstSha = (p.commits||[])[0]||"";
  const payLine = pay.attempted
    ? \`release \${pay.tx_hash || "queued"}\\n→ claimant \${pay.receiver}  \${pay.amount || "—"} \${pay.currency || "NEAR"}\`
    : \`not sent — \${pay.skipped_reason || "rejected"}\${pay.error ? "\\n" + pay.error : ""}\`;
  return \`<div class="card" id="claim-\${esc(r.id)}">
    <div class="row">
      \${statusBadge(r.status)}
      <strong class="mono">\${esc(r.repo)} · op #\${r.seq}</strong>
      <span class="mut">actor \${esc((r.claim.actor||"").slice(0,34))}</span>
      <span class="mut" style="margin-left:auto">\${fmt(r.reviewed_at)}</span>
    </div>
    <div class="flow">
      <div class="step"><h3>1 · claim (dg-ship-1)</h3><pre>session \${esc(p.session_id||"—")}  tool \${esc(p.tool||"—")}
commits  \${esc(((p.commits||[]).map(c=>c.slice(0,10)).join(", "))||"—")}
files \${p.files ?? "—"} · lines +\${p.lines_added ?? "?"}/-\${p.lines_removed ?? "?"}
hash  \${esc((r.claim.hash||"").slice(0,16))}…</pre></div>
      <div class="step"><h3>2 · evidence (recomputed)</h3><pre>hash chain  \${chainOk ? "VALID" : "BROKEN @"+r.chain.broken_at_seq} (\${r.chain.checked} entries)
crosscheck files \${r.crosscheck.recomputed_files} vs claimed \${r.crosscheck.claimed_files ?? "—"}
          lines \${r.crosscheck.recomputed_lines} vs claimed \${r.crosscheck.claimed_lines ?? "—"}
\${commits || "  no commit evidence"}</pre></div>
      <div class="step"><h3>3 · AI adjudicator</h3>
        \${badge((adj.verdict||"—").toUpperCase(), adj.verdict==="accept"?"b-ok":"b-bad")}
        <span class="mut mono">\${esc(adj.model||"")}</span>
        <div class="conf"><i style="width:\${Math.round((adj.confidence||0)*100)}%"></i></div>
        <pre style="margin-top:8px">\${esc(adj.reasoning||"")}</pre></div>
      <div class="step"><h3>4 · NEAR release</h3>
        \${pay.tx_hash ? badge("NEAR","b-pp") : ""}
        <pre>\${esc(payLine)}</pre></div>
    </div>
    <div class="links" style="margin-top:8px;font-size:12px">
      \${'<a href="https://code.widespread.fyi/api/'+r.repo+'/dg/oplog" target="_blank" rel="noopener">op-log ↗</a>'}
      \${firstSha ? '<a href="https://code.widespread.fyi/api/'+r.repo+'/dg/status/'+firstSha+'" target="_blank" rel="noopener">forge receipt ↗</a>' : ""}
      \${pay.tx_hash ? '<a href="https://testnet.nearblocks.io/txns/'+pay.tx_hash+'" target="_blank" rel="noopener">near tx ↗</a>' : ""}
    </div>
  </div>\`;
}

// AG Grid (hackathon sponsor tech) — sortable/filterable tables feeding the
// claim detail cards below. themeQuartz dark via the Theming API.
const gridTheme = (window.agGrid && agGrid.themeQuartz && agGrid.colorSchemeDark)
  ? agGrid.themeQuartz.withPart(agGrid.colorSchemeDark)
  : undefined;
const gridBase = {
  theme: gridTheme,
  defaultColDef: { sortable: true, filter: true, resizable: true },
};
let claimsGrid = null;
let bountiesGrid = null;

function renderBounties(bs) {
  const rows = (bs || []).map(b => ({
    repo: b.repo, bounty: b.amount + " " + b.currency,
    recipient: b.receiver_email, spec: b.spec || "",
  }));
  if (!bountiesGrid) {
    bountiesGrid = agGrid.createGrid($("#bounties-grid"), {
      ...gridBase,
      columnDefs: [
        { field: "repo", width: 170 },
        { field: "bounty", width: 100 },
        { field: "recipient", flex: 1 },
        { field: "spec", flex: 2 },
      ],
      rowData: rows,
    });
  } else {
    bountiesGrid.setGridOption("rowData", rows);
  }
}

function renderClaimsGrid(claims) {
  const rows = (claims || []).map(r => ({
    repo: r.repo, seq: r.seq,
    verdict: r.adjudication ? r.adjudication.verdict : "—",
    confidence: r.adjudication ? r.adjudication.confidence : null,
    payout: r.payout && r.payout.receiver ? r.payout.receiver : "—",
    txn: r.payout && r.payout.tx_hash ? r.payout.tx_hash : "—",
    status: r.status, id: r.id,
  }));
  const statusColor = (v) => v === "accept" || v === "accepted_paid" ? "#2ea043"
    : v === "rejected" || v === "reject" ? "#f85149" : "#8b949e";
  const colDefs = [
    { field: "repo", width: 150 },
    { field: "seq", width: 70, headerName: "op #" },
    { field: "verdict", width: 90,
      cellStyle: p => ({ color: statusColor(p.value), fontWeight: 700 }) },
    { field: "confidence", width: 100, valueFormatter: p =>
        p.value == null ? "—" : (p.value * 100).toFixed(0) + "%",
      cellStyle: p => ({ color: p.value >= 0.6 ? "#2ea043" : "#f85149" }) },
    { field: "payout", flex: 1, headerName: "claimant" },
    { field: "txn", flex: 1, headerName: "release tx",
      cellStyle: { fontFamily: "ui-monospace,monospace", color: "#0070e0" } },
    { field: "status", width: 140,
      cellStyle: p => ({ color: statusColor(p.value), fontWeight: 700 }) },
  ];
  if (!claimsGrid) {
    claimsGrid = agGrid.createGrid($("#claims-grid"), {
      ...gridBase,
      columnDefs: colDefs,
      rowData: rows,
      onRowClicked: (e) => {
        const el = document.getElementById("claim-" + e.data.id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    });
  } else {
    claimsGrid.setGridOption("rowData", rows);
  }
}

async function refresh() {
  try {
    const res = await fetch("/api/state");
    const s = await res.json();
    $("#stamp").textContent = "updated " + new Date().toLocaleTimeString();
    const claims = (s.claims || []).slice().reverse();
    $("#claims").innerHTML = claims.length
      ? claims.map(claimCard).join("") : "no claims reviewed yet";
    renderClaimsGrid(claims);
    const warn = document.getElementById("oplog-warn");
    if (records.length === 0 && warn && !warn.dataset.shown) {
      warn.dataset.shown = "1";
      fetch("https://code.widespread.fyi/api/slop/slopdotcash/dg/oplog")
        .then((r) => r.json())
        .then((d) => { if (!d.entries?.length) warn.style.display = "block"; })
        .catch(() => {});
    }
    renderBounties(s.bounties);
    if (location.hash.startsWith("#/claim/")) {
      const el = document.getElementById("claim-" + location.hash.slice(8));
      if (el) el.scrollIntoView();
    }
  } catch (e) { $("#stamp").textContent = "refresh failed"; }
}

async function runReview(ev, outstanding) {
  ev.preventDefault();
  const repo = $("#f-repo").value.trim();
  const seq = $("#f-seq").value.trim();
  $("#run-out").textContent = " running…";
  const body = outstanding || !seq ? { repo, all: true } : { repo, seq: Number(seq) };
  const res = await fetch("/review", { method:"POST",
    headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
  const j = await res.json().catch(()=>({}));
  $("#run-out").textContent = res.ok
    ? " " + (j.reviewed ?? 1) + " claim(s) → " + (j.status || "done")
    : " error: " + (j.error || res.status);
  refresh();
  return false;
}

function onFilter(v) {
  claimsGrid?.setGridOption("quickFilterText", v);
  bountiesGrid?.setGridOption("quickFilterText", v);
}

refresh(); setInterval(refresh, 8000);
</script>
</body>
</html>`;
