// Sponsor-tool integration: AG Grid (community) renders the public
// payout_trace — every market's escrow → paid/refunded/expired trail as a
// sortable, filterable grid. Devpost sponsor-tool requirement.

import type { Env } from "./types";
import { listRecords } from "./store";

export async function sponsorPage(env: Env): Promise<Response> {
  const records = await listRecords(env).catch(() => []);
  const rows = records.map((r) => ({
    id: r.id,
    repo: r.repo,
    seq: r.seq,
    status: r.status,
    verdict: r.adjudication?.verdict ?? "—",
    confidence: r.adjudication?.confidence ?? "—",
    payout: r.payout?.tx_hash ?? r.payout?.receiver ?? r.payout?.skipped_reason ?? "—",
    amount: r.bounty ? `${r.bounty.amount} ${r.bounty.currency}` : "—",
    reviewed_at: new Date(r.reviewed_at).toISOString(),
  }));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>widespread × AG Grid</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community@33/styles/ag-grid.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community@33/styles/ag-theme-quartz.css">
<style>body{margin:0;background:#0d1117;color:#c9d1d9;font:14px system-ui}header{padding:16px 24px;border-bottom:1px solid #30363d}h1{font-size:18px;margin:0}.ag-theme-quartz{--ag-background-color:#0d1117;--ag-foreground-color:#c9d1d9;height:70vh;width:100%}</style></head><body>
<header><h1>widespread payout trace — powered by <b>AG Grid</b></h1><span>${rows.length} adjudicated claims</span></header>
<div id="grid" class="ag-theme-quartz"></div>
<script src="https://cdn.jsdelivr.net/npm/ag-grid-community@33/dist/ag-grid-community.min.js"></script>
<script>
const rowData = ${JSON.stringify(rows)};
const gridOptions = {
  columnDefs: [
    { field: "repo" }, { field: "seq", width: 80 }, { field: "status" },
    { field: "verdict" }, { field: "confidence", width: 110 },
    { field: "amount" }, { field: "payout", flex: 2, tooltipField: "payout" },
    { field: "reviewed_at" },
  ],
  defaultColDef: { sortable: true, filter: true, resizable: true },
  rowData,
};
agGrid.createGrid(document.getElementById("grid"), gridOptions);
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
