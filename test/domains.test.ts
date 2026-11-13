import { describe, expect, it, vi, beforeAll } from "vitest";
import { getDomain, sniffDomain, validateDomain } from "../src/domains/index";
import { fakeEnv } from "./mock";
import type { MarketRef } from "../src/domains/types";

const env = fakeEnv() as unknown as Record<string, string | undefined>;
const mkt = (over: Partial<MarketRef> = {}): MarketRef => ({
  id: "decl:abc", spec: "write a post about X", domain: "bluesky-post",
  verification: { class: "platform-url", params: { required_terms: ["widespread"], min_length: 20 } },
  created_at: Date.parse("2026-01-01T00:00:00Z"), ...over,
});

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("bsky.app/xrpc/app.bsky.feed.getPostThread")) {
      return Response.json({ thread: { post: {
        uri: "at://did:plc:x/app.bsky.feed.post/abc",
        author: { handle: "worker.bsky.social", did: "did:plc:x" },
        record: { text: "check out widespread — a verified work protocol", createdAt: "2026-02-01T00:00:00Z" },
      } } });
    }
    if (url.includes("/api/v1/statuses/")) {
      return Response.json({ id: "9", account: { acct: "worker" }, content: "<p>this post mentions widespread protocol</p>", created_at: "2026-02-01T00:00:00Z" });
    }
    if (url.includes("publish.twitter.com/oembed")) {
      return Response.json({ html: '<a href="x">widespread verified work protocol post</a> — Worker (@worker)', author_name: "Worker" });
    }
    if (url.includes("youtube.com/oembed")) {
      return Response.json({ title: "widespread protocol walkthrough", author_name: "WorkerChan" });
    }
    if (url.includes("example.com")) {
      return new Response('<html><head><meta property="og:title" content="widespread bounty post"><meta property="og:description" content="verified work protocol content"></head></html>');
    }
    return new Response("nf", { status: 404 });
  }));
});

describe("domain packs", () => {
  it("getDomain finds packs", () => {
    expect(getDomain("bluesky-post")?.name).toBe("bluesky-post");
    expect(getDomain("payer-accept")?.name).toBe("payer-accept");
    expect(getDomain("nope")).toBeNull();
  });
  it("sniffDomain guesses from ref", () => {
    expect(sniffDomain("https://bsky.app/profile/a/post/1").name).toBe("bluesky-post");
    expect(sniffDomain("https://x.com/a/status/1").name).toBe("x-post");
    expect(sniffDomain("https://youtu.be/x").name).toBe("youtube");
    expect(sniffDomain("https://example.com/p").name).toBe("platform-url");
  });
  it("bluesky: resolves + binds + spec-checks", async () => {
    const r = await validateDomain(mkt(), { ref: "https://bsky.app/profile/worker.bsky.social/post/abc", actor: "worker.bsky.social" }, env);
    expect(r.pack).toBe("bluesky-post");
    expect(r.failures).toEqual([]);
    expect(r.evidence.author).toBe("worker.bsky.social");
  });
  it("bluesky: rejects wrong author", async () => {
    const r = await validateDomain(mkt(), { ref: "https://bsky.app/profile/worker.bsky.social/post/abc", actor: "impostor" }, env);
    expect(r.failures.some((f) => f.includes("bind-identity"))).toBe(true);
  });
  it("bluesky: spec failure on missing terms", async () => {
    const r = await validateDomain(mkt({ verification: { class: "platform-url", params: { required_terms: ["absentword"] } } }), { ref: "https://bsky.app/profile/worker.bsky.social/post/abc", actor: "worker.bsky.social" }, env);
    expect(r.failures.some((f) => f.includes("missing term"))).toBe(true);
  });
  it("mastodon: resolves", async () => {
    const r = await validateDomain(mkt({ domain: "mastodon-post" }), { ref: "https://mastodon.social/@worker/9", actor: "worker" }, env);
    expect(r.failures).toEqual([]);
    expect(r.evidence.platform).toBe("mastodon");
  });
  it("x oembed: resolves + binds", async () => {
    const r = await validateDomain(mkt({ domain: "x-post" }), { ref: "https://x.com/worker/status/1", actor: "worker" }, env);
    expect(r.failures).toEqual([]);
  });
  it("youtube: resolves", async () => {
    const r = await validateDomain(mkt({ domain: "youtube", verification: { class: "platform-url" } }), { ref: "https://youtu.be/abc", actor: "WorkerChan" }, env);
    expect(r.failures).toEqual([]);
  });
  it("platform-url: reads og", async () => {
    const r = await validateDomain(mkt({ domain: "platform-url", verification: { class: "platform-url", params: { required_terms: ["widespread"] } } }), { ref: "https://example.com/p" }, env);
    expect(r.failures).toEqual([]);
  });
  it("linkedin: defers to payer-accept", async () => {
    const r = await validateDomain(mkt({ domain: "platform-url", verification: { class: "platform-url" } }), { ref: "https://linkedin.com/posts/x" }, env);
    expect(r.failures.some((f) => f.includes("payer-accept"))).toBe(true);
  });
  it("payer-accept: always passes to funder", async () => {
    const r = await validateDomain(mkt({ domain: "payer-accept" }), { ref: "https://anything" }, env);
    expect(r.failures).toEqual([]);
  });
});
