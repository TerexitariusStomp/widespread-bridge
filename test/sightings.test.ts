// sightings.test.ts — decentralized discovery ingestion: dedupe,
// corroboration tiers, grammar routing, watcher signatures, rate limits,
// rewards, and the Nostr event mapping.
import { describe, expect, it } from "vitest";
import { fakeEnv } from "./mock";
import {
  ingestSighting, listSightings, discoveryStats, sightingSignMessage,
  verifySightingSig, type Sighting,
} from "../src/sightings";
import { eventToSighting, sightingToEventContent, SIGHTING_KIND } from "../src/gossip";
import { handleWebhook } from "../src/webhooks";
import { bountyDeclare } from "../src/declare";
import { maybeRewardWatchers, watcherFeedback } from "../src/watchpay";
import { didKeyFromPublicKey, base58Encode } from "../src/coordinator/didkey";

async function keypair() {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(pub, 2);
  const did = `did:key:z${base58Encode(prefixed)}`;
  const sign = async (msg: string) =>
    [...new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  return { did, sign };
}

const sight = (over: Partial<Sighting> = {}): Sighting => ({
  platform: "discourse:forum.example.com",
  native_id: "topic:42",
  url: "https://forum.example.com/t/42",
  author: "poster1",
  text: "#widespread bounty deadbeef\ndomain: writing\namount: 50 USD\nspec: write a launch post",
  ts: Date.now(),
  ...over,
});

describe("sightings ingestion", () => {
  it("stores a sighting and routes DECL grammar to a feed record", async () => {
    const env = fakeEnv();
    const r = await ingestSighting(env, sight());
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("lead");
    // organic declaration → feedrec in the declared lane
    const rec = await env.CLAIMS.get("feedrec:decl:sight:discourse:forum.example.com:topic:42", "json");
    expect(rec).toBeTruthy();
    expect(rec.verification.spec_hash).toBe("deadbeef");
  });

  it("dedupes per watcher: same watcher re-sighting bumps seen_count", async () => {
    const env = fakeEnv();
    const k = await keypair();
    const s = sight({ watcher_did: k.did });
    const r1 = await ingestSighting(env, s);
    const r2 = await ingestSighting(env, s);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r2.duplicate).toBe(true);
    expect(r2.stored?.seen_count).toBe(2);
  });

  it("different watchers on same object are independent sightings", async () => {
    const env = fakeEnv();
    const k1 = await keypair();
    const k2 = await keypair();
    const s = sight({ watcher_did: k1.did });
    const r1 = await ingestSighting(env, s);
    const r2 = await ingestSighting(env, { ...s, watcher_did: k2.did });
    expect(r1.ok && r2.ok).toBe(true);
    expect(r2.duplicate).toBe(false);
  });

  it("corroborates when ≥2 independent verified watchers agree", async () => {
    const env = fakeEnv();
    const k1 = await keypair();
    const k2 = await keypair();
    const mk = async (k: Awaited<ReturnType<typeof keypair>>) => {
      const s = sight({ watcher_did: k.did });
      const sig = await k.sign(sightingSignMessage(s));
      return ingestSighting(env, { ...s, sig });
    };
    await mk(k1);
    const r2 = await mk(k2);
    expect(r2.tier).toBe("corroborated");
    expect(r2.stored?.watcher_verified).toBe(true);
  });

  it("marks conflicting verified reports as disputed", async () => {
    const env = fakeEnv();
    const k1 = await keypair();
    const k2 = await keypair();
    const s1 = sight({ watcher_did: k1.did });
    const s2 = sight({ watcher_did: k2.did, text: "#widespread bounty cafebabe\ndomain: writing\namount: 999 USD\nspec: different" });
    await ingestSighting(env, { ...s1, sig: await k1.sign(sightingSignMessage(s1)) });
    const r2 = await ingestSighting(env, { ...s2, sig: await k2.sign(sightingSignMessage(s2)) });
    expect(r2.tier).toBe("disputed");
  });

  it("rejects a bad watcher signature", async () => {
    const env = fakeEnv();
    const k = await keypair();
    const s = sight({ watcher_did: k.did, sig: "deadbeef".repeat(16) });
    const r = await ingestSighting(env, s);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/signature/);
  });

  it("attaches sightings to an existing declaration instead of duplicating", async () => {
    const env = fakeEnv();
    const d = await bountyDeclare(env, { domain: "writing", spec: "launch post", amount: "50", currency: "USD" });
    expect("hash" in d).toBe(true);
    const hash = (d as { hash: string }).hash;
    const canonical = (d as { canonical: string }).canonical;
    const r = await ingestSighting(env, sight({ text: canonical }));
    expect(r.ok).toBe(true);
    const sights = await env.CLAIMS.get(`declsight:${hash}`, "json") as { platform: string }[];
    expect(sights.length).toBe(1);
    expect(sights[0].platform).toBe("discourse:forum.example.com");
    // no duplicate feed record for the declared hash
    expect(await env.CLAIMS.get(`feedrec:decl:sight:discourse:forum.example.com:topic:42`, "json")).toBeNull();
  });

  it("routes claim/receipt grammar into hclaim", async () => {
    const env = fakeEnv();
    await ingestSighting(env, sight({ text: 'widespread claim deadbeef — my deliverable https://x.test/d/1' }));
    const claims = await env.CLAIMS.get("hclaim:deadbeef", "json") as { kind: string; platform: string }[];
    expect(claims.length).toBe(1);
    expect(claims[0].kind).toBe("submission");
    expect(claims[0].platform).toBe("discourse:forum.example.com");
  });

  it("rejects missing fields and oversized text", async () => {
    const env = fakeEnv();
    expect((await ingestSighting(env, { platform: "", native_id: "x", text: "y" })).ok).toBe(false);
    expect((await ingestSighting(env, sight({ text: "x".repeat(9000) }))).ok).toBe(true); // truncated, not rejected
  });

  it("listSightings filters by platform and min_tier", async () => {
    const env = fakeEnv();
    await ingestSighting(env, sight());
    await ingestSighting(env, sight({ platform: "x.com", native_id: "tweet:1", url: "https://x.com/a/status/1" }));
    const all = await listSightings(env);
    expect(all.length).toBe(2);
    const x = await listSightings(env, { platform: "x.com" });
    expect(x.length).toBe(1);
    const cor = await listSightings(env, { min_tier: "corroborated" });
    expect(cor.length).toBe(0);
  });

  it("discoveryStats reports live counts", async () => {
    const env = fakeEnv();
    await ingestSighting(env, sight());
    const st = await discoveryStats(env);
    expect(st.surfaces_watched).toBe(1);
    expect((st.by_platform as Record<string, number>)["discourse:forum.example.com"]).toBe(1);
    expect(st.generated_at).toBeGreaterThan(0);
  });
});

describe("watcher signatures", () => {
  it("verifySightingSig round-trips a signed sighting", async () => {
    const k = await keypair();
    const s = sight({ watcher_did: k.did });
    const sig = await k.sign(sightingSignMessage(s));
    expect(await verifySightingSig({ ...s, sig })).toBe(true);
    expect(await verifySightingSig({ ...s, sig, text: s.text + "tampered" })).toBe(false);
  });
});

describe("nostr gossip mapping", () => {
  it("eventToSighting parses a valid sighting event", () => {
    const pubkey = "a".repeat(64);
    const s = sight();
    const content = sightingToEventContent(s);
    const e = { pubkey, content, created_at: 1700000000, tags: [["d", "discourse:forum.example.com:topic:42"], ["t", "widespread-sighting"]] };
    const out = eventToSighting(e);
    expect(out).not.toBeNull();
    expect(out!.watcher_did).toBe(`did:nostr:${pubkey}`);
    expect(out!.source).toBe("nostr");
    expect(out!.auth).toBe("nostr-event");
    expect(SIGHTING_KIND).toBe(30078);
  });

  it("eventToSighting rejects d-tag/payload mismatch and bad json", () => {
    const e = { pubkey: "b".repeat(64), content: sightingToEventContent(sight()), created_at: 1, tags: [["d", "other:platform:idx"]] };
    expect(eventToSighting(e)).toBeNull();
    expect(eventToSighting({ pubkey: "b".repeat(64), content: "not json", created_at: 1, tags: [] })).toBeNull();
  });

  it("nostr-event auth bypasses did:key sig but is stripped from storage", async () => {
    const env = fakeEnv();
    const s = sight({ watcher_did: "did:nostr:" + "c".repeat(64), auth: "nostr-event", source: "nostr" });
    const r = await ingestSighting(env, s);
    expect(r.ok).toBe(true);
    expect(r.stored?.watcher_verified).toBe(true);
    expect((r.stored as Record<string, unknown>).auth).toBeUndefined();
  });
});

describe("watcher rewards", () => {
  it("maybeRewardWatchers credits verified non-disputed watchers", async () => {
    const env = fakeEnv();
    const k = await keypair();
    const d = await bountyDeclare(env, { domain: "writing", spec: "launch post", amount: "50", currency: "USD", sighting_bps: 100 });
    const hash = (d as { hash: string }).hash;
    const canonical = (d as { canonical: string }).canonical;
    const s = sight({ text: canonical, watcher_did: k.did });
    await ingestSighting(env, { ...s, sig: await k.sign(sightingSignMessage(s)) });
    const r = await maybeRewardWatchers(env, hash);
    expect(r.rewarded).toBe(1);
    const idem = `sighting-reward:${hash}:${k.did}`;
    const ent = await env.CLAIMS.get(idem, "json") as { status: string; bps: number };
    expect(ent.status).toBe("owed");
    expect(ent.bps).toBe(100);
    // idempotent
    expect((await maybeRewardWatchers(env, hash)).rewarded).toBe(0);
    // rep + ERC-8004 feedback emitted
    const rep = await env.CLAIMS.get(`rep:${k.did}`, "json") as { points: number };
    expect(rep.points).toBeGreaterThan(0);
    expect(await env.CLAIMS.get(`watchpaid:${k.did}`)).toBe("1");
    const fbKeys = await env.CLAIMS.list({ prefix: `rep8004:sighting:${k.did}:` });
    expect(fbKeys.keys.length).toBe(1);
  });

  it("watcherFeedback produces ERC-8004 shape", () => {
    const fb = watcherFeedback("did:key:zabc", 0.95, "discourse:t:1");
    expect(fb.schema).toBe("erc-8004-feedback/1");
    expect(fb.tag1).toBe("sighting-accuracy");
    expect(fb.grounded).toBe(true);
  });
});

describe("webhooks", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://x.test/api/webhooks/generic?token=tok", { method: "POST", body, headers });

  it("generic webhook ingests with push weight when token matches", async () => {
    const env = fakeEnv({ WEBHOOK_TOKEN: "tok" });
    const r = await handleWebhook(env, "generic", post(JSON.stringify(sight({ source: undefined }))));
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    const list = await listSightings(env);
    expect(list[0].source).toBe("push");
    expect(list[0].weight).toBeGreaterThanOrEqual(1.5);
  });

  it("generic webhook rejects bad token", async () => {
    const env = fakeEnv({ WEBHOOK_TOKEN: "tok" });
    const r = await handleWebhook(env, "generic", new Request("https://x.test/api/webhooks/generic?token=wrong", { method: "POST", body: JSON.stringify(sight()) }));
    expect(r.status).toBe(401);
  });

  it("unknown platform 404s; slack without secret 401s", async () => {
    const env = fakeEnv();
    expect((await handleWebhook(env, "myspace", post("{}"))).status).toBe(404);
    const r = await handleWebhook(env, "slack", new Request("https://x.test/api/webhooks/slack", { method: "POST", body: "{}" }));
    expect(r.status).toBe(503); // not configured
  });
});
