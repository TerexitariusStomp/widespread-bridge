import { describe, expect, it, vi, beforeAll } from "vitest";
import { queryFeed, feedRss } from "../src/feed";
import { handleMcpRequest } from "../src/mcp";
import type { FeedDoc, FeedRecord, Env } from "../src/types";

// All upstream fetches fail fast in tests — sources degrade independently.
beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
});

const rec = (over: Partial<FeedRecord>): FeedRecord => ({
  id: "t:1", source: "github", forge: "github", kind: "bounty",
  title: "fix the bug", url: "https://x/1",
  escrow: { state: "locked" },
  updated_at: 1000,
  ...over,
});

const doc = (records: FeedRecord[]): FeedDoc => ({
  generated_at: Date.now(), sources: {}, records,
});

describe("queryFeed", () => {
  const records = [
    rec({ id: "a", est_usd: 50, forge: "github", repo: "o/r1", competition: { pending_claims: 1 } }),
    rec({ id: "b", est_usd: 30, forge: "tangled", source: "tangled", escrow: { state: "external" }, competition: { pending_claims: 9 } }),
    rec({ id: "c", est_usd: 10, forge: "github", repo: "o/r2", escrow: { state: "none" }, updated_at: 2000 }),
  ];

  it("filters by forge", () => {
    expect(queryFeed(doc(records), { forge: "tangled" }).records.map((r) => r.id)).toEqual(["b"]);
  });
  it("filters by source prefix", () => {
    expect(queryFeed(doc(records), { source: "github-thirdparty" }).records).toEqual([]);
    const d2 = doc([rec({ id: "x", source: "github-thirdparty:algora" })]);
    expect(queryFeed(d2, { source: "github-thirdparty" }).records[0].id).toBe("x");
  });
  it("filters by repo, q, min_usd, escrow", () => {
    expect(queryFeed(doc(records), { repo: "o/r2" }).records[0].id).toBe("c");
    expect(queryFeed(doc(records), { q: "fix the" }).records.length).toBe(3);
    expect(queryFeed(doc(records), { q: "nonexistent" }).records.length).toBe(0);
    expect(queryFeed(doc(records), { min_usd: 20 }).records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(queryFeed(doc(records), { escrow: "external" }).records[0].id).toBe("b");
  });
  it("max_competition filters crowded bounties", () => {
    expect(queryFeed(doc(records), { max_competition: 2 }).records.map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("sorts by reward desc by default, newest, trust", () => {
    expect(queryFeed(doc(records), {}).records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(queryFeed(doc(records), { sort: "newest" }).records[0].id).toBe("c");
    const trusted = doc([
      rec({ id: "low", est_usd: 100, escrow: { state: "none" }, trust: { repo_pass_rate: 0.1 } }),
      rec({ id: "high", est_usd: 10, escrow: { state: "locked" }, trust: { repo_pass_rate: 0.9 } }),
    ]);
    expect(queryFeed(trusted, { sort: "trust" }).records[0].id).toBe("high");
  });
  it("cursor paginates stably", () => {
    const page1 = queryFeed(doc(records), { limit: 2 });
    expect(page1.records.length).toBe(2);
    expect(page1.next_cursor).toBe("2");
    const page2 = queryFeed(doc(records), { limit: 2, cursor: page1.next_cursor! });
    expect(page2.records.length).toBe(1);
    expect(page2.next_cursor).toBeNull();
  });
});

describe("feedRss", () => {
  it("emits valid Atom with escaped content", () => {
    const xml = feedRss(doc([rec({ title: "a <b> & \"c\"", amount: "3", currency: "USD", competition: { pending_claims: 2 } })]), "https://x");
    expect(xml).toContain("<feed");
    expect(xml).toContain("<entry>");
    expect(xml).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
    expect(xml).toContain("2 claims");
    expect(xml).not.toContain("<b>");
  });
});

describe("handleMcp (SDK Streamable HTTP)", () => {
  const kvStub = {
    get: async () => null, put: async () => {}, delete: async () => {},
    list: async () => ({ keys: [] }),
  };
  const env = { CLAIMS: kvStub } as unknown as Env;
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const call = (body: unknown) =>
    handleMcpRequest(new Request("https://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }), env, ctx);
  const rpcJson = async (res: Response) => {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const m = (await res.text()).match(/data: (\{.*\})/);
      return JSON.parse(m?.[1] ?? "{}");
    }
    return res.json();
  };

  it("initialize negotiates current protocol + serverInfo", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const body = await rpcJson(res) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("widespread");
    expect(body.result.protocolVersion).toMatch(/^20/);
  });
  it("notifications return 202", async () => {
    const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });
  it("tools/list exposes feed + earn tools", async () => {
    await call({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await rpcJson(res) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(
      ["feed_search", "feed_get", "feed_stats", "runners_list",
       "wide_markets", "wide_agent_challenge", "wide_agent_register",
       "wide_claim", "wide_ship_prepare", "wide_ship_submit", "wide_status"]));
  });
  it("feed_stats works on empty doc (KV stub falls back)", async () => {
    await call({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "feed_stats", arguments: {} } });
    expect(res.status).toBe(200);
  });
});

