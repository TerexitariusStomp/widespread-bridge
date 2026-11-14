// identity.test.ts — cross-surface binding: every platform tier, replay,
// revocation, re-verify-on-delete, style-score semantics.
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  bindStatement, parseBindStatement, registerBinding, resolveHandle,
  listBindings, revokeBinding, reverifyBinding, verifyBindProof,
} from "../src/identity";
import { styleScore, fetchTimeline } from "../src/domains/history";
import { bountyDeclare } from "../src/declare";
import { fakeKV, fakeEnv, fetchRouter, jsonRes } from "./mock";

const DID = "did:dg:test1111";
const stmt = (platform: string, handle: string) => bindStatement(DID, platform, handle);

beforeEach(() => vi.unstubAllGlobals());

describe("bind statement", () => {
  it("round-trips through parse", () => {
    const s = stmt("github", "alice");
    expect(parseBindStatement(`some prose\n${s}\nmore`)).toEqual({ did: DID, platform: "github", handle: "alice" });
  });
  it("strips trailing punctuation from handles", () => {
    expect(parseBindStatement(stmt("x", "bob") + ".")?.handle).toBe("bob");
  });
  it("returns null on no statement", () => {
    expect(parseBindStatement("hello world")).toBeNull();
  });
});

describe("github proofs", () => {
  const gist = (login: string, content: string) => jsonRes({ owner: { login }, files: { "bind.md": { content } } });

  it("verifies a gist proof at proof tier", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("alice", stmt("github", "alice"))]]));
    const env = fakeEnv();
    const r = await registerBinding(env, { did: DID, platform: "github", handle: "alice", proof: "https://gist.github.com/alice/" + "a".repeat(32) });
    expect(r.ok).toBe(true);
    expect(r.binding?.tier).toBe("proof");
  });

  it("rejects a gist authored by someone else", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("mallory", stmt("github", "alice"))]]));
    const r = await registerBinding(fakeEnv(), { did: DID, platform: "github", handle: "alice", proof: "https://gist.github.com/mallory/" + "b".repeat(32) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/author @mallory != alice/);
  });

  it("rejects a gist missing the statement (replay can't bind)", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("alice", "no statement here")]]));
    const r = await registerBinding(fakeEnv(), { did: DID, platform: "github", handle: "alice", proof: "https://gist.github.com/alice/" + "c".repeat(32) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/statement not in gist/);
  });

  it("verifies an issue-comment proof", async () => {
    vi.stubGlobal("fetch", fetchRouter([["issues/comments/99", () => jsonRes({ user: { login: "alice" }, body: stmt("github", "alice") })]]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "github", handle: "alice", proof: "https://github.com/o/r/issues/3#issuecomment-99" });
    expect(v).toMatchObject({ ok: true, tier: "proof" });
  });
});

describe("other forge proofs", () => {
  it("gitlab snippet", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["snippets/7/raw", () => new Response(stmt("gitlab", "alice"))],
      ["api/v4/snippets/7", () => jsonRes({ author: { username: "alice" } })],
    ]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "gitlab", handle: "alice", proof: "https://gitlab.com/alice/-/snippets/7" });
    expect(v.ok).toBe(true);
  });

  it("forgejo issue comment", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api/v1/repos/", () => jsonRes([{ body: stmt("forgejo", "alice"), user: { login: "alice" } }])]]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "forgejo", handle: "alice", proof: "https://codeberg.org/o/r/issues/9" });
    expect(v.ok).toBe(true);
  });
});

describe("social proofs", () => {
  const bskyPost = (handle: string, did: string, text: string) => jsonRes({ thread: { post: { author: { handle, did }, record: { text }, uri: `at://${did}/app.bsky.feed.post/x` } } });

  it("bluesky post → proof tier", async () => {
    vi.stubGlobal("fetch", fetchRouter([["getPostThread", () => bskyPost("alice.bsky.social", "did:plc:zzz", stmt("bluesky", "alice.bsky.social"))]]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "bluesky", handle: "alice.bsky.social", proof: "https://bsky.app/profile/alice.bsky.social/post/abc" });
    expect(v.tier).toBe("proof");
  });

  it("bluesky post upgrades to native when did == account's atproto did", async () => {
    const atdid = "did:plc:zzz";
    vi.stubGlobal("fetch", fetchRouter([["getPostThread", () => bskyPost("alice.bsky.social", atdid, bindStatement(atdid, "bluesky", "alice.bsky.social"))]]));
    const v = await verifyBindProof(fakeEnv(), { did: atdid, platform: "bluesky", handle: "alice.bsky.social", proof: "https://bsky.app/profile/alice.bsky.social/post/abc" });
    expect(v.tier).toBe("native");
  });

  it("mastodon status", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api/v1/statuses/", () => jsonRes({ id: "1", account: { acct: "alice" }, content: `<p>${stmt("mastodon", "alice")}</p>` })]]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "mastodon", handle: "alice", proof: "https://hachyderm.io/@alice/1" });
    expect(v.ok).toBe(true);
  });

  it("hn comment", async () => {
    vi.stubGlobal("fetch", fetchRouter([["hn.algolia.com", () => jsonRes({ id: 1, author: "alice", text: `<p>${stmt("hackernews", "alice")}</p>` })]]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "hackernews", handle: "alice", proof: "https://news.ycombinator.com/item?id=1" });
    expect(v.ok).toBe(true);
  });

  it("x oembed is weak without bearer; bearer upgrades to proof", async () => {
    const oembed = jsonRes({ html: `<p>${stmt("x", "alice")}</p> — Alice (@alice)` });
    vi.stubGlobal("fetch", fetchRouter([["oembed", () => oembed.clone()]]));
    const v1 = await verifyBindProof(fakeEnv(), { did: DID, platform: "x", handle: "alice", proof: "https://x.com/alice/status/5" });
    expect(v1).toMatchObject({ ok: true, tier: "weak" });

    vi.stubGlobal("fetch", fetchRouter([["api.x.com", () => jsonRes({ data: { text: stmt("x", "alice") }, includes: { users: [{ username: "alice" }] } })]]));
    const v2 = await verifyBindProof(fakeEnv({ X_BEARER_TOKEN: "t" }), { did: DID, platform: "x", handle: "alice", proof: "https://x.com/alice/status/5" });
    expect(v2).toMatchObject({ ok: true, tier: "proof" });
  });

  it("gated platform (linkedin) is weak tier via statement-in-page", async () => {
    vi.stubGlobal("fetch", fetchRouter([["linkedin.com", () => new Response(`<html>${stmt("linkedin", "alice")}</html>`)]]));
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "linkedin", handle: "alice", proof: "https://www.linkedin.com/posts/alice_x" });
    expect(v).toMatchObject({ ok: true, tier: "weak" });
  });
});

describe("signature proofs", () => {
  it("evm eip-191 verifies a real signature", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const sig = await acct.signMessage({ message: bindStatement(DID, "evm", acct.address) });
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "evm", handle: acct.address, proof: sig });
    expect(v).toMatchObject({ ok: true, tier: "sig" });
  });

  it("evm rejects a signature from the wrong address", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const acct = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const other = privateKeyToAccount(`0x${"33".repeat(32)}`);
    const sig = await other.signMessage({ message: bindStatement(DID, "evm", acct.address) });
    const v = await verifyBindProof(fakeEnv(), { did: DID, platform: "evm", handle: acct.address, proof: sig });
    expect(v.ok).toBe(false);
  });

  it("solana ed25519 verifies", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const sig = ed25519.sign(new TextEncoder().encode(bindStatement(DID, "solana", hex(pk))), sk);
    const v = await verifyBindProof(fakeEnv(), {
      did: DID, platform: "solana", handle: hex(pk),
      proof: JSON.stringify({ pubkey: hex(pk), sig: hex(sig) }),
    });
    expect(v).toMatchObject({ ok: true, tier: "sig" });
  });
});

describe("storage, replay, revocation", () => {
  const gist = (login: string, content: string) => jsonRes({ owner: { login }, files: { "bind.md": { content } } });
  const proofUrl = "https://gist.github.com/alice/" + "d".repeat(32);

  it("a handle can't be double-bound to different DIDs", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("alice", stmt("github", "alice"))]]));
    const env = fakeEnv();
    await registerBinding(env, { did: DID, platform: "github", handle: "alice", proof: proofUrl });
    const r2 = await registerBinding(env, { did: "did:dg:mallory", platform: "github", handle: "alice", proof: proofUrl });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/already bound/);
  });

  it("resolveHandle round-trips", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("alice", stmt("github", "alice"))]]));
    const env = fakeEnv();
    await registerBinding(env, { did: DID, platform: "github", handle: "alice", proof: proofUrl });
    expect(await resolveHandle(env, "github", "Alice")).toEqual({ did: DID, tier: "proof" });
    expect(await resolveHandle(env, "github", "mallory")).toBeNull();
  });

  it("listBindings returns all bindings for a did", async () => {
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("alice", stmt("github", "alice"))]]));
    const env = fakeEnv();
    await registerBinding(env, { did: DID, platform: "github", handle: "alice", proof: proofUrl });
    const bs = await listBindings(env, DID);
    expect(bs).toHaveLength(1);
    expect(bs[0].platform).toBe("github");
  });

  it("revoke requires the DID's registered key signature", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const kv = fakeKV({ [`agentdid:${DID}`]: JSON.stringify({ pubkey: hex(pk) }) });
    const env = fakeEnv({ CLAIMS: kv as never });
    vi.stubGlobal("fetch", fetchRouter([["api.github.com/gists/", () => gist("alice", stmt("github", "alice"))]]));
    await registerBinding(env, { did: DID, platform: "github", handle: "alice", proof: proofUrl });

    const bad = await revokeBinding(env, { did: DID, platform: "github", handle: "alice", sig_hex: "00".repeat(64) });
    expect(bad.ok).toBe(false);

    const msg = new TextEncoder().encode(`widespread-revoke:v1\n${DID}\ngithub\nalice`);
    const sig = hex(ed25519.sign(msg, sk));
    const ok = await revokeBinding(env, { did: DID, platform: "github", handle: "alice", sig_hex: sig });
    expect(ok.ok).toBe(true);
    expect(await resolveHandle(env, "github", "alice")).toBeNull();
  });

  it("reverify revokes when the statement was deleted", async () => {
    let live = true;
    vi.stubGlobal("fetch", async () => live ? gist("alice", stmt("github", "alice")) : jsonRes({}, 404));
    const env = fakeEnv();
    await registerBinding(env, { did: DID, platform: "github", handle: "alice", proof: proofUrl });
    live = false;
    const r = await reverifyBinding(env, DID, "github", "alice");
    expect(r.ok).toBe(false);
    expect(await resolveHandle(env, "github", "alice")).toBeNull();
  });
});

describe("style score — soft signal semantics", () => {
  const samples = [
    "shipping the new escrow flow today, fees stay flat",
    "honest take: reviewer attention is the scarce resource",
    "new post: why permissionless verification wins",
  ];

  it("similar text scores higher than dissimilar", async () => {
    const close = styleScore("shipping verification today — honest take on fees", samples);
    const far = styleScore("quantum chromodynamics lattice gauge theory seminar", samples);
    expect(close.score).toBeGreaterThan(far.score);
  });

  it("returns 0 with a note when no samples", () => {
    const s = styleScore("anything", []);
    expect(s.score).toBe(0);
    expect(s.note).toMatch(/no public history/);
  });

  it("never claims authorship — note carries the caveat", () => {
    expect(styleScore("x", samples).note).toMatch(/not an authorship/);
  });
});

describe("fetchTimeline", () => {
  it("bluesky author feed", async () => {
    vi.stubGlobal("fetch", fetchRouter([["getAuthorFeed", () => jsonRes({ feed: [{ post: { record: { text: "hello" } } }, { post: { record: { text: "world" } } }] })]]));
    const tl = await fetchTimeline(fakeEnv(), "bluesky", "alice.bsky.social", 10);
    expect(tl.samples).toEqual(["hello", "world"]);
  });

  it("gated platforms return no samples with gated flag", async () => {
    const tl = await fetchTimeline(fakeEnv(), "linkedin", "alice", 10);
    expect(tl.samples).toEqual([]);
    expect(tl.gated).toBe(true);
  });
});

describe("declare cross-surface target", () => {
  it("for: resolves bound status and lands on the record", async () => {
    const kv = fakeKV({ "idhandle:bluesky:alice.bsky.social": JSON.stringify({ did: DID, tier: "proof" }), [`idbind:${DID}:bluesky:alice.bsky.social`]: JSON.stringify({ did: DID, platform: "bluesky", handle: "alice.bsky.social", tier: "proof", proof: "u", verified_at: 1 }) });
    const env = fakeEnv({ CLAIMS: kv as never });
    const d = await bountyDeclare(env, {
      domain: "social-media", spec: "ghostwrite a bsky post about escrow", amount: "25", capacity: { dims: ["C_k"], evidence_plan: { measure: "deliverable verified", horizon_days: 30 } },
      target_platform: "bluesky", target_handle: "alice.bsky.social",
    });
    if ("error" in d) throw new Error(d.error);
    expect(d.record.for).toEqual({ platform: "bluesky", handle: "alice.bsky.social", bound: true });
    expect(d.record.deliverable_class).toBe("draft");
    expect(d.canonical).toMatch(/for: bluesky @alice\.bsky\.social/);
  });

  it("unbound target warns but still declares", async () => {
    const d = await bountyDeclare(fakeEnv(), {
      domain: "social-media", spec: "ghostwrite a linkedin post", amount: "25", capacity: { dims: ["C_k"], evidence_plan: { measure: "deliverable verified", horizon_days: 30 } },
      target_platform: "linkedin", target_handle: "alice",
    });
    if ("error" in d) throw new Error(d.error);
    expect(d.record.for?.bound).toBe(false);
    expect(d.warnings?.[0]).toMatch(/not bound/);
  });
});
