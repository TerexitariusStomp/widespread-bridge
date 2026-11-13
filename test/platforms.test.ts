// platforms.test.ts — fyi-gateway parity: every new domain pack + identity
// verifier + scanner shape, mocked platform APIs.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateDomain, sniffDomain } from "../src/domains/index";
import { verifyBindProof, bindStatement } from "../src/identity";
import { pollLemmy, pollHive, pollDevto, pollMisskey } from "../src/socialfeed";
import { fetchTimeline } from "../src/domains/history";
import { fakeEnv, fetchRouter, jsonRes } from "./mock";

const DID = "did:dg:plt";
const market = (over: Record<string, unknown> = {}) => ({
  id: "m", domain: "auto", created_at: Date.now() - 3600e3,
  verification: { class: "platform-url", params: { required_terms: ["escrow"] } },
  ...over,
});
const claim = (ref: string, actor = "alice") => ({ ref, actor });
const env = fakeEnv();

beforeEach(() => vi.unstubAllGlobals());

const SPEC_TEXT = "escrow markets settle verified work";

describe("domain packs — proof tier", () => {
  it("lemmy post: author + spec check", async () => {
    vi.stubGlobal("fetch", fetchRouter([["/api/v3/post", () => jsonRes({ post_view: { post: { name: "t", body: SPEC_TEXT, published: new Date().toISOString() }, creator: { name: "alice" } } })]]));
    const v = await validateDomain(market(), claim("https://lemmy.world/post/42"), env as never);
    expect(v.pack).toBe("lemmy-post");
    expect(v.failures).toEqual([]);
  });

  it("lemmy: wrong author rejects", async () => {
    vi.stubGlobal("fetch", fetchRouter([["/api/v3/post", () => jsonRes({ post_view: { post: { name: "t", body: SPEC_TEXT }, creator: { name: "mallory" } } })]]));
    const v = await validateDomain(market(), claim("https://lemmy.world/post/42"), env as never);
    expect(v.failures.join()).toMatch(/author @mallory/);
  });

  it("misskey note", async () => {
    vi.stubGlobal("fetch", fetchRouter([["/api/notes/show", () => jsonRes({ user: { username: "alice" }, text: SPEC_TEXT, createdAt: new Date().toISOString() })]]));
    const v = await validateDomain(market(), claim("https://misskey.io/notes/abc123"), env as never);
    expect(v.pack).toBe("misskey-note");
    expect(v.failures).toEqual([]);
  });

  it("wordpress via slug", async () => {
    vi.stubGlobal("fetch", fetchRouter([["wp-json/wp/v2/posts", () => jsonRes([{ id: 9, content: { rendered: `<p>${SPEC_TEXT}</p>` }, date: new Date().toISOString(), _embedded: { author: [{ slug: "alice" }] } }])]]));
    const v = await validateDomain(market({ domain: "wordpress-post" }), claim("https://blog.example.com/2026/01/my-post/"), env as never);
    expect(v.pack).toBe("wordpress-post");
    expect(v.failures).toEqual([]);
    expect(v.evidence.author).toBe("alice");
  });

  it("hive: on-chain author binds", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.hive.blog", () => jsonRes({ result: { author: "alice", title: "t", body: SPEC_TEXT, created: new Date().toISOString() } })]]));
    const v = await validateDomain(market(), claim("https://peakd.com/@alice/my-post"), env as never);
    expect(v.pack).toBe("hive-post");
    expect(v.failures).toEqual([]);
    expect(v.evidence.chain).toBe("on-chain content");
  });

  it("devto: username lookup → article", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["articles?username=alice", () => jsonRes([{ slug: "my-post-123", id: 7 }])],
      ["api/articles/7", () => jsonRes({ id: 7, title: "t", body_markdown: SPEC_TEXT, published_at: new Date().toISOString(), user: { username: "alice" } })],
    ]));
    const v = await validateDomain(market(), claim("https://dev.to/alice/my-post-123"), env as never);
    expect(v.pack).toBe("devto-article");
    expect(v.failures).toEqual([]);
  });

  it("hashnode gql", async () => {
    vi.stubGlobal("fetch", fetchRouter([["gql.hashnode.com", () => jsonRes({ data: { publication: { post: { title: "t", publishedAt: new Date().toISOString(), author: { username: "alice" }, content: { markdown: SPEC_TEXT } } } } })]]));
    const v = await validateDomain(market(), claim("https://alice.hashnode.dev/my-post"), env as never);
    expect(v.pack).toBe("hashnode-post");
    expect(v.failures).toEqual([]);
  });

  it("peertube video", async () => {
    vi.stubGlobal("fetch", fetchRouter([["/api/v1/videos/", () => jsonRes({ uuid: "u1", name: "t", description: SPEC_TEXT, channel: { name: "alice" }, publishedAt: new Date().toISOString() })]]));
    const v = await validateDomain(market(), claim("https://peertube.tv/w/abc-def"), env as never);
    expect(v.pack).toBe("peertube-video");
    expect(v.failures).toEqual([]);
  });

  it("audius resolve", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.audius.co/v1/resolve", () => jsonRes({ data: { id: "t9", title: "t", description: SPEC_TEXT, user: { handle: "alice" } } })]]));
    const v = await validateDomain(market(), claim("https://audius.co/alice/my-track"), env as never);
    expect(v.pack).toBe("audius-track");
    expect(v.failures).toEqual([]);
  });

  it("blogger feed match", async () => {
    vi.stubGlobal("fetch", fetchRouter([["feeds/posts/default", () => jsonRes({ feed: { entry: [{ link: [{ rel: "alternate", href: "https://me.blogspot.com/2026/01/p.html" }], title: { $t: "t" }, content: { $t: `<p>${SPEC_TEXT}</p>` }, author: [{ name: { $t: "alice" } }], published: { $t: new Date().toISOString() } }] } })]]));
    const v = await validateDomain(market(), claim("https://me.blogspot.com/2026/01/p.html"), env as never);
    expect(v.pack).toBe("blogger-post");
    expect(v.failures).toEqual([]);
  });

  it("substack feed match", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>me</title><item><title>t</title><link>https://me.substack.com/p/hello</link><description>${SPEC_TEXT}</description><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">alice</dc:creator></item></channel></rss>`;
    vi.stubGlobal("fetch", fetchRouter([["substack.com/feed", () => new Response(rss)]]));
    const v = await validateDomain(market(), claim("https://me.substack.com/p/hello"), env as never);
    expect(v.pack).toBe("substack-post");
    expect(v.failures).toEqual([]);
  });

  it("tiktok oembed — weak-tier flag", async () => {
    vi.stubGlobal("fetch", fetchRouter([["tiktok.com/oembed", () => jsonRes({ author_name: "alice", title: "my video" })]]));
    const v = await validateDomain(market({ verification: { class: "platform-url", params: {} } }), claim("https://www.tiktok.com/@alice/video/1"), env as never);
    expect(v.pack).toBe("tiktok-video");
    expect(v.failures.join()).toMatch(/weak-tier/);
  });

  it("activitypub fallback resolves any fedi object", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["vlemmy.world/post/9", () => jsonRes({ type: "Note", name: "t", content: `<p>${SPEC_TEXT}</p>`, attributedTo: "https://vlemmy.world/u/alice", published: new Date().toISOString() })],
      ["vlemmy.world/u/alice", () => jsonRes({ preferredUsername: "alice" })],
    ]));
    const v = await validateDomain(market({ domain: "activitypub-object" }), claim("https://vlemmy.world/post/9"), env as never);
    expect(v.failures).toEqual([]);
    expect(v.evidence.author).toBe("alice");
  });
});

describe("sniffDomain", () => {
  it.each([
    ["https://dev.to/alice/post-1", "devto-article"],
    ["https://alice.hashnode.dev/p", "hashnode-post"],
    ["https://peakd.com/@alice/p", "hive-post"],
    ["https://audius.co/a/t", "audius-track"],
    ["https://me.blogspot.com/2026/p.html", "blogger-post"],
    ["https://me.substack.com/p/x", "substack-post"],
    ["https://www.tiktok.com/@a/video/1", "tiktok-video"],
    ["https://pixelfed.social/p/a/1", "pixelfed-post"],
    ["https://misskey.io/notes/abc", "misskey-note"],
    ["https://peertube.tv/w/xyz", "peertube-video"],
    ["https://lemmy.world/post/5", "lemmy-post"],
  ])("%s → %s", (ref, pack) => {
    expect(sniffDomain(ref).name).toBe(pack);
  });
});

describe("identity verifiers — new platforms", () => {
  const stmt = (p: string) => bindStatement(DID, p, "alice");

  it("lemmy comment proof", async () => {
    vi.stubGlobal("fetch", fetchRouter([["/api/v3/comment", () => jsonRes({ comment_view: { comment: { content: stmt("lemmy") }, creator: { name: "alice" } } })]]));
    const v = await verifyBindProof(env, { did: DID, platform: "lemmy", handle: "alice", proof: "https://lemmy.world/comment/9" });
    expect(v).toMatchObject({ ok: true, tier: "proof" });
  });

  it("hive on-chain proof upgrades to native when did==account", async () => {
    const text = bindStatement("hive:alice", "hive", "alice");
    vi.stubGlobal("fetch", fetchRouter([["api.hive.blog", () => jsonRes({ result: { author: "alice", body: text } })]]));
    const v = await verifyBindProof(env, { did: "hive:alice", platform: "hive", handle: "alice", proof: "https://peakd.com/@alice/p" });
    expect(v).toMatchObject({ ok: true, tier: "native" });
  });

  it("devto wrong-author rejects", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["articles?username=", () => jsonRes([{ slug: "p", id: 1 }])],
      ["api/articles/1", () => jsonRes({ user: { username: "mallory" }, body_markdown: stmt("devto") })],
    ]));
    const v = await verifyBindProof(env, { did: DID, platform: "devto", handle: "alice", proof: "https://dev.to/alice/p" });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/mallory/);
  });

  it("substack feed weak tier", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>me</title><item><link>https://me.substack.com/p/b</link><description>${stmt("substack")}</description></item></channel></rss>`;
    vi.stubGlobal("fetch", fetchRouter([["substack.com/feed", () => new Response(rss)]]));
    const v = await verifyBindProof(env, { did: DID, platform: "substack", handle: "alice", proof: "https://me.substack.com/p/b" });
    expect(v).toMatchObject({ ok: true, tier: "weak" });
  });
});

describe("new scanners", () => {
  it("lemmy ingests declarations + binds", async () => {
    const bind = bindStatement(DID, "lemmy", "alice");
    vi.stubGlobal("fetch", fetchRouter([["api/v3/search", () => jsonRes({ posts: [
      { post: { id: 1, name: "t", body: `#widespread bounty aabbccdd\ndomain: code\namount: 5 USD`, ap_id: "https://lemmy.world/post/1" }, creator: { name: "alice" } },
      { post: { id: 2, name: "b", body: bind, ap_id: "https://lemmy.world/comment/2" }, creator: { name: "alice" } },
    ] })], ["/api/v3/post?id=", () => jsonRes({ post_view: { post: { name: "b", body: bind }, creator: { name: "alice" } } })],
      ["/api/v3/comment?id=", () => jsonRes({ comment_view: { comment: { content: bind }, creator: { name: "alice" } } })]]));
    const recs = await pollLemmy(env);
    expect(recs.length).toBe(2); // both configured instances poll
    expect(recs[0].id).toContain("lemmy");
  });

  it("hive ingests tag results", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.hive.blog", () => jsonRes({ result: [{ author: "alice", permlink: "p", title: "t", body: `#widespread bounty aabbccdd` }] })]]));
    const recs = await pollHive(env);
    expect(recs.length).toBe(1);
    expect(recs[0].source).toBe("social-hive");
  });

  it("devto ingests tag articles", async () => {
    vi.stubGlobal("fetch", fetchRouter([["dev.to/api/articles?tag", () => jsonRes([{ id: 3, title: "t", description: `#widespread bounty aabbccdd`, url: "https://dev.to/a/p-3", user: { username: "alice" } }])]]));
    const recs = await pollDevto(env);
    expect(recs.length).toBe(1);
  });

  it("misskey ingests search notes", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api/notes/search", () => jsonRes([{ id: "n1", text: `#widespread bounty aabbccdd`, user: { username: "alice" } }])]]));
    const recs = await pollMisskey(env);
    expect(recs.length).toBe(1);
    expect(recs[0].url).toContain("misskey.io/notes/n1");
  });
});

describe("timelines", () => {
  it("devto timeline", async () => {
    vi.stubGlobal("fetch", fetchRouter([["articles?username=alice", () => jsonRes([{ title: "post one", description: "d1" }, { title: "post two", description: "d2" }])]]));
    const tl = await fetchTimeline(env, "devto", "alice", 10);
    expect(tl.samples.length).toBe(2);
  });

  it("hive timeline", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.hive.blog", () => jsonRes({ result: [{ title: "t1", body: "b1" }] })]]));
    const tl = await fetchTimeline(env, "hive", "alice", 10);
    expect(tl.samples).toEqual(["t1\nb1"]);
  });
});
