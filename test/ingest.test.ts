import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env, MirrorListing } from "../src/types";

const feedDocMock = vi.fn();
vi.mock("../src/feedstore", () => ({ getFeedDoc: (...a: unknown[]) => feedDocMock(...a) }));

import { scanMirrorSubmissions } from "../src/ingest";
import { fakeEnv, fakeKV, fetchRouter, jsonRes } from "./mock";

const mirror = (over: Partial<MirrorListing> = {}): MirrorListing => ({
  id: "mirror:github-thirdparty:generic:o/r#1",
  record_id: "github-thirdparty:generic:o/r#1",
  title: "bounty", url: "https://x", repo: "o/r",
  original: { amount: "50", currency: "USD", est_usd: 50 },
  cut_bps: 1000, spec: "s", spec_hash: "h",
  createMarketArgs: {}, status: "funded",
  created_at: 0, updated_at: 0,
  ...over,
});

const timelineWithPr = (prNum = 55) => [
  { event: "cross-referenced",
    source: { issue: { number: prNum, pull_request: {}, state: "open",
      user: { id: 888, login: "carol" } } } },
];

const ghFetch = () => fetchRouter([
  ["/timeline", () => jsonRes(timelineWithPr())],
  ["/issues/55", () => jsonRes({ number: 55, state: "open", title: "pr",
    user: { id: 888, login: "carol" }, pull_request: {}, head: { sha: "b".repeat(40) } })],
  ["/pulls/55/files", () => jsonRes([{ filename: "z.ts", status: "added",
    patch: "@@ -0,0 +1 @@\n+new" }])],
]);

function env(kv = fakeKV()) {
  return fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"], ATTEST_SECRET: "s" });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  feedDocMock.mockReset();
});

describe("scanMirrorSubmissions", () => {
  it("files an attested auto-ingested claim for a cross-referenced PR", async () => {
    feedDocMock.mockResolvedValue({ mirrors: [mirror()] });
    const kv = fakeKV({
      "escrowstate:mirror:github-thirdparty:generic:o/r#1":
        JSON.stringify({ status: "confirmed" }),
    });
    vi.stubGlobal("fetch", ghFetch());
    const r = await scanMirrorSubmissions(env(kv));
    expect(r.claims_filed).toBe(1);
    expect(r.errors).toEqual([]);
    const claims = [...kv.map.entries()].filter(([k]) => k.startsWith("mclaim:mirror:"));
    expect(claims).toHaveLength(1);
    const claim = JSON.parse(claims[0][1]);
    expect(claim.auto_ingested).toBe(true);
    expect(claim.attested).toBe(true);
    expect(claim.payout).toBeNull(); // winner supplies address at verdict
    expect(claim.forgeRef).toContain("/pull/55");
  });

  it("skips unfunded mirrors entirely", async () => {
    feedDocMock.mockResolvedValue({ mirrors: [mirror()] });
    vi.stubGlobal("fetch", ghFetch());
    const r = await scanMirrorSubmissions(env(fakeKV())); // no escrowstate record
    expect(r.scanned).toBe(0);
    expect(r.claims_filed).toBe(0);
  });

  it("dedupes: second scan files nothing", async () => {
    feedDocMock.mockResolvedValue({ mirrors: [mirror()] });
    const kv = fakeKV({
      "escrowstate:mirror:github-thirdparty:generic:o/r#1":
        JSON.stringify({ status: "confirmed" }),
    });
    vi.stubGlobal("fetch", ghFetch());
    const e = env(kv);
    await scanMirrorSubmissions(e);
    const r2 = await scanMirrorSubmissions(e);
    expect(r2.claims_filed).toBe(0);
  });

  it("backs off on github rate limit", async () => {
    feedDocMock.mockResolvedValue({ mirrors: [mirror()] });
    const kv = fakeKV({
      "escrowstate:mirror:github-thirdparty:generic:o/r#1":
        JSON.stringify({ status: "confirmed" }),
    });
    vi.stubGlobal("fetch", fetchRouter([
      ["api.github.com", () => new Response("limited", { status: 429 })],
    ]));
    const r = await scanMirrorSubmissions(env(kv));
    expect(r.errors.join()).toMatch(/rate limited/);
    expect(r.claims_filed).toBe(0);
  });
});
