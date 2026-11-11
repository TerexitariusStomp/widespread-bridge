import { afterEach, describe, expect, it, vi } from "vitest";
import { listDispatchSubmissions, scanDispatchChannels } from "../src/collect";
import { fakeEnv, fakeKV } from "./mock";
import type { Env } from "../src/types";

function jobHex(status: number): string {
  // Repo-variant getJob: head word 0x20, then 9-slot tuple at offset 32.
  const w = (v: bigint | string) => BigInt(v).toString(16).padStart(64, "0");
  const head = "20".padStart(64, "0");
  const words = [w(0), w(0), w(0), w(0), w(64 * 9), w(100), w(0), w(2000), w(status)];
  const strLen = w(4) + "dead".padEnd(64 - 8, "0");
  return "0x" + head + words.join("") + strLen;
}

const channel = (over: object) => ({
  id: "1:agentledger", market_id: "1", platform: "agentledger",
  kind: "native", state: "active", rail: "platform", ref: "7",
  spec_hash: "x", market_url: "u", claim_url: "c", created_at: 1, updated_at: 1,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("scanDispatchChannels", () => {
  it("files one deduped submission when a platform job is Submitted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: jobHex(2) }),
      { headers: { "content-type": "application/json" } })));
    const kv = fakeKV({ "dispatch:1:agentledger": JSON.stringify(channel({})) });
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      AGENTLEDGER_RPC: "https://rpc", AGENTLEDGER_CONTRACT: "0xabc",
    });
    const first = await scanDispatchChannels(env);
    const second = await scanDispatchChannels(env);
    expect(first.submissions).toBe(1);
    expect(second.submissions).toBe(0); // dedupe — no double filing
    const subs = await listDispatchSubmissions(env, "1");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.platform).toBe("agentledger");
    // channel flipped to collecting
    const rec = await kv.get("dispatch:1:agentledger", "json") as { state: string };
    expect(rec.state).toBe("collecting");
  });

  it("ignores channels without refs and failed calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const kv = fakeKV({
      "dispatch:2:a2a": JSON.stringify(channel({ platform: "a2a", ref: undefined, rail: "widespread" })),
      "dispatch:2:agentledger": JSON.stringify(channel({ platform: "agentledger", id: "2:agentledger" })),
    });
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      AGENTLEDGER_RPC: "https://rpc", AGENTLEDGER_CONTRACT: "0xabc",
    });
    const res = await scanDispatchChannels(env);
    expect(res.submissions).toBe(0);
    expect(res.scanned).toBe(1);
  });
});

describe("tiered content dedup", () => {
  it("marks identical content on a second channel as duplicate", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo) => {
      calls++;
      if (String(u).includes("submissions")) {
        return new Response(JSON.stringify({ data: { submissions: [
          { id: "s1", content: "The quick brown fox jumps over the lazy dog and delivers the patch" },
          { id: "s2", content: "The quick brown fox jumps over the lazy dog and delivers the patch" },
        ] } }), { headers: { "content-type": "application/json" } });
      }
      return new Response("x", { status: 500 });
    }));
    const kv = fakeKV({
      "dispatch:5:wurk": JSON.stringify(channel({ platform: "wurk", id: "5:wurk", market_id: "5", ref: "j1" })),
    });
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      WURK_API_KEY: "k", WURK_API: "https://api.wurk.fun",
    });
    const res = await scanDispatchChannels(env);
    expect(res.submissions).toBe(1); // second identical content → duplicate, not filed
    const subs = await listDispatchSubmissions(env, "5");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.duplicate_of).toBe("wurk:s1");
  });
});
