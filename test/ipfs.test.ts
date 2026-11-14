// ipfs.test.ts — pinning degrades cleanly when unconfigured and pins
// ciphertext bytes when a Kubo node is present.
import { describe, expect, it, vi, afterEach } from "vitest";
import { pinBytes, handlePin } from "../src/ipfs";
import { fakeEnv } from "./mock";
import type { Env } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

describe("IPFS pinning", () => {
  it("fails soft with no node configured", async () => {
    const r = await pinBytes(fakeEnv(), new Uint8Array([1, 2, 3]));
    expect(r.error).toMatch(/IPFS_API_URL/);
    expect(r.cid).toBeUndefined();
  });

  it("pins to Kubo and reports remote pin when configured", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v0/add")) {
        return new Response(JSON.stringify({ Hash: "bafytestcid", Size: "3" }), { status: 200 });
      }
      if (url.endsWith("/pins")) return new Response("{}", { status: 202 });
      return new Response("{}", { status: 404 });
    }));
    const env = fakeEnv({
      IPFS_API_URL: "http://node.test:5001",
      IPFS_PINNING_URL: "https://pin.svc",
      IPFS_PINNING_KEY: "k",
    } as Partial<Env>);
    const r = await pinBytes(env, new Uint8Array([1, 2, 3]), "spec-sealed");
    expect(r.cid).toBe("bafytestcid");
    expect(r.pinned_remotely).toBe(true);
    expect(calls.some((u) => u.includes("/api/v0/add?cid-version=1"))).toBe(true);
    expect(calls.some((u) => u === "https://pin.svc/pins")).toBe(true);
  });

  it("rejects malformed and oversized /api/pin payloads", async () => {
    const bad = await handlePin(
      new Request("https://x/api/pin", { method: "POST", body: JSON.stringify({ data_b64: "!!!" }) }),
      fakeEnv());
    expect(bad.status).toBe(400);
    const big = await handlePin(
      new Request("https://x/api/pin", { method: "POST",
        body: JSON.stringify({ data_b64: btoa("a".repeat(2 * 1024 * 1024 + 1)) }) }),
      fakeEnv());
    expect(big.status).toBe(413);
    // unconfigured node → 503, not a fake cid
    const r = await handlePin(
      new Request("https://x/api/pin", { method: "POST",
        body: JSON.stringify({ data_b64: btoa("hi") }) }),
      fakeEnv());
    expect(r.status).toBe(503);
  });
});
