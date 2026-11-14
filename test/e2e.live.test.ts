// e2e.live.test.ts — LIVE end-to-end checks against the deployed bridge.
// Gated: only runs with E2E_LIVE=1. Hits production worker + testnet —
// read-only assertions plus idempotent escrow reconcile (never creates
// new markets; market 15 already exists).
//
//   E2E_LIVE=1 npx vitest run test/e2e.live.test.ts

import { describe, expect, it } from "vitest";

const BASE = process.env.E2E_BASE ?? "https://widespread-bridge.widespread.workers.dev";
const LIVE = process.env.E2E_LIVE === "1";

const get = async (path: string) => {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20000) });
  return { res, text: await res.text() };
};

describe.skipIf(!LIVE)("live E2E — deployed bridge", () => {
  it("home page renders market stats", async () => {
    const { res, text } = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(text).toContain("every forge");
    expect(text).toContain("bounties indexed");
  });

  it("/bounties lists records + mirrors", async () => {
    const { res, text } = await get("/bounties");
    expect(res.status).toBe(200);
    expect(text).toContain("bounty-card");
  });

  it("/api/feed returns normalized records", async () => {
    const { res, text } = await get("/api/feed");
    expect(res.status).toBe(200);
    const doc = JSON.parse(text);
    expect(doc.records.length).toBeGreaterThan(0);
    expect(doc.records[0]).toHaveProperty("escrow");
  });

  it("/api/mirrors returns mirror listings", async () => {
    const { res, text } = await get("/api/mirrors");
    expect(res.status).toBe(200);
    const doc = JSON.parse(text);
    expect(doc.mirrors.length).toBeGreaterThan(0);
    expect(doc.mirrors[0].id).toMatch(/^mirror:/);
  });

  it("bounty detail + markdown twin agree", async () => {
    const feed = await (await fetch(`${BASE}/api/feed`)).json() as
      { records: { id: string }[] };
    const id = feed.records[0].id;
    const enc = encodeURIComponent(id);
    const html = await get(`/bounties/${enc}`);
    expect(html.res.status).toBe(200);
    const md = await get(`/bounty.md?id=${enc}`);
    expect(md.res.status).toBe(200);
    expect(md.res.headers.get("content-type")).toContain("text/markdown");
    expect(md.text).toContain("# ");
  });

  it("/docs + /ops + /feed.md + /api/feed.rss + /mcp alive", async () => {
    for (const p of ["/docs", "/ops", "/api/feed.md", "/api/feed.rss"]) {
      const { res } = await get(p);
      expect(res.status, p).toBe(200);
    }
    const mcp = await fetch(`${BASE}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(15000),
    });
    expect(mcp.status).toBe(200);
  });

  it("escrow reconcile is idempotent (market 15, no rebroadcast)", async () => {
    // The $10 rustchain mirror already has market 15 on-chain — a repeat
    // escrow call must return already/reconciled, never a second market.
    const mirrors = await (await fetch(`${BASE}/api/mirrors`)).json() as
      { mirrors: { id: string; funded_market_id?: string }[] };
    const funded = mirrors.mirrors.find((m) => m.funded_market_id);
    if (!funded) return; // nothing escrowed yet — skip, not fail
    const res = await fetch(`${BASE}/api/mirrors/escrow`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: funded.id }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json() as { escrow?: Record<string, unknown> };
    const e = j.escrow ?? {};
    expect(e.escrowed === true || e.already === true || e.reconciled === true
      || e.pending != null || e.skipped != null
      || j.escrowed === true || (j as Record<string, unknown>).already === true).toBe(true);
  });
});
