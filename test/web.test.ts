import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FeedDoc, FeedRecord, MirrorListing, Env } from "../src/types";

const feedDocMock = vi.fn();
vi.mock("../src/feed", () => ({ feedDoc: (...a: unknown[]) => feedDocMock(...a) }));

import { homePage, bountiesPage, bountyPage, fundPage, docsPage, bountyMarkdown } from "../src/web/pages";

const record = (over: Partial<FeedRecord>): FeedRecord => ({
  id: "github-thirdparty:generic:o/r#1", source: "github-thirdparty:generic",
  forge: "github", kind: "bounty", repo: "o/r", title: "Fix the parser bug",
  url: "https://github.com/o/r/issues/1", escrow: { state: "external" },
  est_usd: 100, spec: "Fix the parser.", updated_at: Date.now() - 3600_000,
  ...over,
});

const mirror = (over: Partial<MirrorListing>): MirrorListing => ({
  id: "mirror:github-thirdparty:generic:o/r#1",
  record_id: "github-thirdparty:generic:o/r#1",
  title: "Fix the parser bug", url: "https://github.com/o/r/issues/1",
  original: { amount: "100", currency: "USD", est_usd: 100 },
  cut_bps: 1000, claimant_share: { est_usd: 90 },
  spec: "Fix the parser.", spec_hash: "sha256:abc",
  createMarketArgs: {}, status: "seeking-funder",
  created_at: Date.now(), updated_at: Date.now(),
  ...over,
});

const doc: FeedDoc = {
  generated_at: Date.now(),
  sources: { github: { ok: true, count: 5, fetched_at: Date.now() } },
  records: [record({})],
  mirrors: [mirror({})],
};

const env = { CLAIMS: { get: vi.fn(async () => null), put: vi.fn(), list: vi.fn(async () => ({ keys: [], list_complete: true })) } } as unknown as Env;

beforeEach(() => feedDocMock.mockResolvedValue(doc));

describe("web pages", () => {
  it("home renders stats + top bounties + how-it-works", async () => {
    const res = await homePage(env);
    const t = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(t).toContain("every forge");
    expect(t).toContain("Fix the parser bug");
    expect(t).toContain("How it works");
    expect(t).toContain("mirror-only");
  });

  it("bounties page lists records + mirrors with filter toolbar", async () => {
    const t = await (await bountiesPage(env)).text();
    expect(t).toContain("Bounties");
    expect(t).toContain("filter title");
    expect(t).toContain("also on generic".replace("generic", "algora") === "x" ? "" : "Fix the parser bug");
  });

  it("bounty detail shows mirror fund CTA + spec", async () => {
    const t = await (await bountyPage(env, undefined, "mirror:github-thirdparty:generic:o/r#1")).text();
    expect(t).toContain("Fund this bounty");
    expect(t).toContain("Escrow on NEAR");
    expect(t).toContain("face value");
    expect(t).toContain("platform cut");
    expect(t).toContain("Fix the parser.");
  });

  it("bounty detail 404s cleanly on unknown id", async () => {
    const t = await (await bountyPage(env, undefined, "mirror:nope")).text();
    expect(t).toContain("No bounty with that id");
  });

  it("fund page renders timeline even without funding", async () => {
    const t = await (await fundPage(env, undefined, "mirror:x")).text();
    expect(t).toContain("Funding status");
    expect(t).toContain("NEAR escrow");
  });

  it("bounty markdown twin renders agent-readable fields", async () => {
    const res = await bountyMarkdown(env, undefined, "mirror:github-thirdparty:generic:o/r#1");
    const t = await res.text();
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(t).toContain("# Fix the parser bug");
    expect(t).toContain("mirror_id");
    expect(t).toContain("POST /api/mirrors/claims");
    expect(t).toContain("platform cut");
  });

  it("escapes HTML in titles/specs (XSS)", async () => {
    feedDocMock.mockResolvedValue({
      generated_at: Date.now(), sources: {},
      records: [record({ title: "<script>alert(1)</script>", spec: "<img onerror=x>" })],
      mirrors: [],
    });
    const t = await (await bountiesPage(env)).text();
    expect(t).not.toContain("<script>alert(1)</script>");
    expect(t).toContain("&lt;script&gt;");
    const d = await (await bountyPage(env, undefined,
      "github-thirdparty:generic:o/r#1")).text();
    expect(d).not.toContain("<img onerror=x>");
    expect(d).toContain("&lt;img");
  });

  it("docs page covers feed surfaces + standards status", async () => {
    const t = await docsPage().text();
    expect(t).toContain("/api/feed");
    expect(t).toContain("ERC-8004");
    expect(t).toContain("x402");
    expect(t).toContain("mirror-only");
  });
});
