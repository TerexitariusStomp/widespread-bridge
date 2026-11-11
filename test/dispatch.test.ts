import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCard, createDispatch, handleA2a, listDispatches, markDispatch, settleCalldata } from "../src/dispatch";
import { fakeEnv, fakeKV } from "./mock";
import type { Env } from "../src/types";

function nearResponse(market: unknown): Response {
  const bytes = [...new TextEncoder().encode(JSON.stringify(market))];
  return new Response(JSON.stringify({ result: { result: bytes } }), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("outbound dispatch descriptors", () => {
  it("creates idempotent descriptor records bound to an open canonical market", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse({
      status: "open", spec: "Review the protocol docs", specHash: "ab12", locked: "1000",
    })));
    const kv = fakeKV();
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    const input = { market_id: "42", platforms: ["a2a", "mcp", "a2a"] };

    const first = await createDispatch(env, input, "https://wide.example");
    const second = await createDispatch(env, input, "https://wide.example");

    expect(first.records).toHaveLength(2);
    expect(second.records).toEqual(first.records);
    expect(first.records?.[0]).toMatchObject({
      market_id: "42", kind: "descriptor", state: "prepared", spec_hash: "ab12",
      market_url: "https://wide.example/api/markets?market_id=42",
    });
    expect(kv.map.size).toBe(2);
  });

  it("rejects non-open jobs and unsupported surfaces without writing records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse({
      status: "paid", spec: "Done", locked: "1000",
    })));
    const kv = fakeKV();
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    const closed = await createDispatch(env, { market_id: "4", platforms: ["a2a"] }, "https://wide.example");
    const unsupported = await createDispatch(env, { market_id: "4", platforms: ["unknown"] }, "https://wide.example");

    expect(closed.status).toBe(409);
    expect(unsupported.status).toBe(400);
    expect(kv.map.size).toBe(0);
  });

  it("lists descriptors globally or by canonical market", async () => {
    const kv = fakeKV({
      "dispatch:1:a2a": JSON.stringify({ id: "1:a2a", market_id: "1", created_at: 1 }),
      "dispatch:2:mcp": JSON.stringify({ id: "2:mcp", market_id: "2", created_at: 2 }),
    });
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    expect((await listDispatches(env)).map((d) => d.market_id)).toEqual(["2", "1"]);
    expect((await listDispatches(env, "1")).map((d) => d.market_id)).toEqual(["1"]);
  });

  it("publishes A2A discovery metadata linked to existing API surfaces", () => {
    const card = agentCard("https://wide.example");
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.url).toBe("https://wide.example/a2a");
    expect(card.skills.map((s) => s.id)).toContain("discover-funded-work");
    expect(card.endpoints.claims).toBe("https://wide.example/api/claims");
  });

  it("serves funded-market discovery as a completed A2A task", async () => {
    const response = await handleA2a(new Request("https://wide.example/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "Find funded work" }] } },
      }),
    }), async () => ({ markets: [{ marketId: "7" }], total: 1 }));
    const body = await response.json() as {
      result: { status: { state: string }; artifacts: { parts: { text: string }[] }[] };
    };
    expect(body.result.status.state).toBe("completed");
    expect(JSON.parse(body.result.artifacts[0]!.parts[0]!.text)).toMatchObject({
      operation: "discover-funded-work", data: { total: 1 },
    });
  });
});

describe("native channels, spend_auth, settle", () => {
  const openMarket = { status: "open", spec: "Audit the escrow contract", specHash: "c0de", locked: "1000" };
  const auth = {
    authorized_by: "0xfunder", platform: "agentledger",
    ceiling: 10, currency: "USDC", expiry: Math.floor(Date.now() / 1000) + 3600, sig: "0xsig",
  };

  it("native 8183 channel requires spend_auth and yields createJob calldata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse(openMarket)));
    const kv = fakeKV();
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      AGENTLEDGER_CONTRACT: "0x6262a7D4D6cBd4a72C7c1a92A49F3AbaFa2DB5Fc",
    });
    const noAuth = await createDispatch(env, { market_id: "9", platforms: ["agentledger"] }, "https://wide.example");
    expect(noAuth.records).toHaveLength(0);
    expect(noAuth.skipped_no_auth).toEqual(["agentledger"]);

    const withAuth = await createDispatch(env, {
      market_id: "9", platforms: ["agentledger"], spend_auth: [auth],
    }, "https://wide.example");
    const rec = withAuth.records![0]!;
    expect(rec.kind).toBe("native");
    expect(rec.rail).toBe("platform");
    expect(rec.prepared_tx!.to).toBe("0x6262a7D4D6cBd4a72C7c1a92A49F3AbaFa2DB5Fc");
    expect(rec.prepared_tx!.data.startsWith("0xbaf3ede2")).toBe(true); // createJob selector
  });

  it("expired mandate does not cover a native channel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse(openMarket)));
    const env = fakeEnv({ AGENTLEDGER_CONTRACT: "0x6262a7D4D6cBd4a72C7c1a92A49F3AbaFa2DB5Fc" });
    const res = await createDispatch(env, {
      market_id: "9", platforms: ["agentledger"],
      spend_auth: [{ ...auth, expiry: 1 }],
    }, "https://wide.example");
    expect(res.records).toHaveLength(0);
  });

  it("mark flips prepared→active and settleCalldata encodes complete()", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse(openMarket)));
    const kv = fakeKV();
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    await createDispatch(env, { market_id: "9", platforms: ["a2a"] }, "https://wide.example");
    const marked = await markDispatch(env, "9", "a2a", "job-77");
    expect(marked!.state).toBe("active");
    expect(marked!.ref).toBe("job-77");
    expect(await markDispatch(env, "9", "nonexistent", "x")).toBeNull();

    const data = settleCalldata(77, `0x${"ab".padEnd(64, "0")}`);
    expect(data.startsWith("0xd75bbdf3")).toBe(true); // complete(uint256,bytes32,bytes)
    expect(data.includes("4d".padStart(64, "0"))).toBe(true); // jobId 77 = 0x4d
  });
});

describe("escrow-first invariant", () => {
  it("rejects dispatch on an unfunded market — we never front money", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse({
      status: "open", spec: "Do work", specHash: "h", locked: "0",
    })));
    const env = fakeEnv();
    const res = await createDispatch(env, { market_id: "5", platforms: ["a2a"] }, "https://wide.example");
    expect(res.status).toBe(409);
    expect(res.error).toContain("never front money");
  });

  it("native prepared_tx carries no sender — only the funder's wallet signs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => nearResponse({
      status: "open", spec: "Audit", specHash: "h", locked: "1000",
    })));
    const env = fakeEnv({ AGENTLEDGER_CONTRACT: "0x6262a7D4D6cBd4a72C7c1a92A49F3AbaFa2DB5Fc" });
    const unsigned = await createDispatch(env, {
      market_id: "9", platforms: ["agentledger"],
      spend_auth: [{ authorized_by: "0xf", platform: "agentledger", ceiling: 10, currency: "USDC", expiry: Date.now() / 1000 + 60 }],
    }, "https://wide.example");
    expect(unsigned.records).toHaveLength(0); // unsigned mandate rejected

    const signed = await createDispatch(env, {
      market_id: "9", platforms: ["agentledger"],
      spend_auth: [{ authorized_by: "0xf", platform: "agentledger", ceiling: 10, currency: "USDC", expiry: Date.now() / 1000 + 60, sig: "0xsig" }],
    }, "https://wide.example");
    const tx = signed.records![0]!.prepared_tx!;
    expect(tx).not.toHaveProperty("from");
    expect(tx).not.toHaveProperty("value"); // no funds attached — funder escrows via fund() themselves
    expect(tx.note).toContain("FUNDER signs");
  });
});
