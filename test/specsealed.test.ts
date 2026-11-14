// specsealed.test.ts — D3 funder-sealed spec lane: the bridge never holds
// plaintext at rest. Judge-capable variant opens its copy in-request only
// (hash-bound); full-blind delegates reveal + adjudication to the funder.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { bountyDeclare, getDeclared, specReveal } from "../src/declare";
import { declEscrowPlan } from "../src/escrow";
import {
  newSealedKeyPair, sealTo, sealOpen, bridgeX25519PublicKey, sha256Hex,
} from "../src/sealed";
import { runReview } from "../src/review";
import { entryHash } from "../src/forges/deltagit";
import { fakeEnv, fakeKV, fetchRouter, jsonRes } from "./mock";
import { ed25519 } from "@noble/curves/ed25519";
import type { Env } from "../src/types";

beforeEach(() => vi.unstubAllGlobals());

const CAP = { dims: ["C_k" as const], evidence_plan: { measure: "deliverable verified", horizon_days: 30 } };
const SPEC = "write a heartfelt 200-word eulogy for my father, a retired carpenter";
const DELIVERABLE = "He measured twice and cut once — in wood and in kindness…";
const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

async function specHashOf(text: string) {
  return `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;
}

async function registerAgent(kv: ReturnType<typeof fakeKV>) {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = toHex(ed25519.getPublicKey(secret));
  await kv.put(`agent:${pub}`, JSON.stringify({ pubkey: pub, did: "did:key:zAgent", label: "t" }));
  return { secret, pub };
}

async function revealArgs(hash: string, agent: { secret: Uint8Array; pub: string }, x25519: string) {
  const canon = `widespread-spec-reveal\n${hash}\n${x25519}`;
  return { hash, agent_pubkey: agent.pub, x25519_pubkey: x25519,
           signature_hex: toHex(ed25519.sign(new TextEncoder().encode(canon), agent.secret)) };
}

// ------------------------------------------------------------- declare
describe("D3 spec_sealed declaration", () => {
  const env = fakeEnv();
  const kp = newSealedKeyPair();

  it("rejects spec plaintext alongside spec_sealed", async () => {
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec: SPEC, spec_hash: await specHashOf(SPEC),
      reveal_endpoint: "https://funder.example/reveal",
      funder_x25519_pubkey: kp.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    expect(d.error).toMatch(/must not carry spec plaintext/);
  });

  it("requires spec_hash and a reveal path", async () => {
    const noHash = await bountyDeclare(env, {
      spec_sealed: true, reveal_endpoint: "https://funder.example/reveal",
      funder_x25519_pubkey: kp.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    expect(noHash.error).toMatch(/spec_hash/);
    const noPath = await bountyDeclare(env, {
      spec_sealed: true, spec_hash: await specHashOf(SPEC),
      funder_x25519_pubkey: kp.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    expect(noPath.error).toMatch(/reveal path/);
    const noFunder = await bountyDeclare(env, {
      spec_sealed: true, spec_hash: await specHashOf(SPEC),
      reveal_endpoint: "https://funder.example/reveal",
      domain: "writing", amount: "50", capacity: CAP,
    });
    expect(noFunder.error).toMatch(/funder_x25519_pubkey/);
  });

  it("stores ciphertext fields only — spec never enters KV", async () => {
    const kv = fakeKV();
    const e = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    const spec_hash = await specHashOf(SPEC);
    const d = await bountyDeclare(e, {
      spec_sealed: true, spec_hash, spec_cid: "bafySpecCid",
      reveal_endpoint: "https://funder.example/reveal",
      funder_x25519_pubkey: kp.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    expect(d.error).toBeUndefined();
    expect(d.canonical).toContain("confidential: spec-sealed");
    expect(d.canonical).toContain("cid:bafySpecCid");
    expect(d.canonical).not.toContain("eulogy");
    const b = await getDeclared(e, d.hash);
    expect(b?.spec).toBe("");                          // zero at-rest plaintext
    expect(b?.spec_sealed).toBe(true);
    expect(b?.spec_hash).toBe(spec_hash);
    expect(b?.spec_cid).toBe("bafySpecCid");
    expect(b?.confidential).toBe(true);                // implied
    expect(b?.reveal_endpoint).toBe("https://funder.example/reveal");
  });
});

// ------------------------------------------------------------- reveal
describe("D3 spec reveal lanes", () => {
  it("judge-capable copy: bridge opens in-request, hash-binds, seals to claimant", async () => {
    const kv = fakeKV();
    const bridge = newSealedKeyPair();
    const funder = newSealedKeyPair();
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      BRIDGE_X25519_SECRET: bridge.secretKey,
    } as Partial<Env>);
    const spec_hash = await specHashOf(SPEC);
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec_hash,
      spec_sealed_bridge_b64: sealTo(new TextEncoder().encode(SPEC), bridge.publicKey),
      funder_x25519_pubkey: funder.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    const agent = await registerAgent(kv);
    const claimant = newSealedKeyPair();
    const res = await specReveal(env, await revealArgs(d.hash as string, agent, claimant.publicKey));
    expect(res.error).toBeUndefined();
    expect(res.mode).toBe("bridge-sealed");
    const pt = sealOpen(res.spec_sealed_b64 as string, claimant.secretKey);
    expect(new TextDecoder().decode(pt!)).toBe(SPEC);
    expect(res.spec_hash).toBe(spec_hash);
  });

  it("rejects a bridge copy that doesn't bind to spec_hash", async () => {
    const kv = fakeKV();
    const bridge = newSealedKeyPair();
    const funder = newSealedKeyPair();
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      BRIDGE_X25519_SECRET: bridge.secretKey,
    } as Partial<Env>);
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec_hash: await specHashOf(SPEC),
      // ciphertext seals DIFFERENT text — hash check must catch it
      spec_sealed_bridge_b64: sealTo(new TextEncoder().encode("a different spec entirely"), bridge.publicKey),
      funder_x25519_pubkey: funder.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    const agent = await registerAgent(kv);
    const res = await specReveal(env, await revealArgs(d.hash as string, agent, newSealedKeyPair().publicKey));
    expect(res.error).toMatch(/does not match spec_hash/);
  });

  it("full-blind: reveal delegates to the funder endpoint — bridge has nothing to give", async () => {
    const kv = fakeKV();
    const funder = newSealedKeyPair();
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    const spec_hash = await specHashOf(SPEC);
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec_hash, spec_cid: "bafySpecCid",
      reveal_endpoint: "https://funder.example/reveal",
      funder_x25519_pubkey: funder.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    const agent = await registerAgent(kv);
    const res = await specReveal(env, await revealArgs(d.hash as string, agent, newSealedKeyPair().publicKey));
    expect(res.error).toBeUndefined();
    expect(res.mode).toBe("delegated");
    expect(res.reveal_endpoint).toBe("https://funder.example/reveal");
    expect(res.spec_cid).toBe("bafySpecCid");
    expect(res.spec_sealed_b64).toBeUndefined();       // no bridge copy exists
    // the reveal request is still logged — the funder's demand signal
    const logged = (await kv.list({ prefix: `specreveal:${d.hash}:` })).keys.length;
    expect(logged).toBe(1);
  });
});

// ------------------------------------------------------------- review
describe("D3 spec_sealed review", () => {
  async function claimEntry(hash: string, sealed: Record<string, unknown>, sha: string) {
    const entry = {
      seq: 1, kind: "push.patch", actor: "did:key:zWorker",
      payload: {
        work_id: hash, ref: `sealed://${sha}`,
        evidence: { artifact_sealed: sealed }, actor: "did:key:zWorker",
        claimant: "worker.testnet", commits: [],
      },
      created_at: Date.now(), prev_hash: "genesis", hash: "",
    };
    entry.hash = await entryHash(entry as never, "genesis");
    return entry;
  }

  it("full-blind market: funder-only deliverable → delegated record, no panel", async () => {
    const kv = fakeKV();
    const funder = newSealedKeyPair();
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      FORGES: JSON.stringify({ "widespread/writing": { type: "deltagit", base: "https://forge.test" } }),
      AI: { run: async () => { throw new Error("panel must not run on full-blind markets"); } },
    } as Partial<Env>);
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec_hash: await specHashOf(SPEC),
      reveal_endpoint: "https://funder.example/reveal",
      funder_x25519_pubkey: funder.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    const bytes = new TextEncoder().encode(DELIVERABLE);
    const sha = await sha256Hex(bytes);
    const artifact_sealed = {
      ciphertext_funder_b64: sealTo(bytes, funder.publicKey),  // funder copy only
      artifact_sha256: `sha256:${sha}`,
    };
    const entry = await claimEntry(d.hash as string, artifact_sealed, sha);
    vi.stubGlobal("fetch", fetchRouter([
      ["/dg/oplog", () => jsonRes({ entries: [entry] })],
      ["proof.t16z", () => jsonRes({})],
    ]));
    const rec = await runReview(env, "widespread/writing", 1, { force: true });
    expect(rec.status).toBe("delegated");
    expect(rec.adjudication).toBeNull();
    const blob = JSON.stringify(rec);
    expect(blob).toContain("artifact_sealed");          // ciphertext kept
    expect(blob).not.toContain("eulogy");
    expect(blob).not.toContain(DELIVERABLE);
  });

  it("judge-capable: panel sees in-request spec; record stays clean", async () => {
    const kv = fakeKV();
    const bridge = newSealedKeyPair();
    const funder = newSealedKeyPair();
    let specSeenByJudge = "";
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      BRIDGE_X25519_SECRET: bridge.secretKey,
      FORGES: JSON.stringify({ "widespread/writing": { type: "deltagit", base: "https://forge.test" } }),
      AI: { run: async (_m: string, opts: { messages?: { role: string; content: string }[] }) => {
        specSeenByJudge = opts?.messages?.map((m) => m.content).join("\n") ?? "";
        return { response: JSON.stringify({ verdict: "accept", reasoning: "fits", confidence: 0.9 }) };
      } },
    } as Partial<Env>);
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec_hash: await specHashOf(SPEC),
      spec_sealed_bridge_b64: sealTo(new TextEncoder().encode(SPEC), bridge.publicKey),
      funder_x25519_pubkey: funder.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    const bytes = new TextEncoder().encode(DELIVERABLE);
    const sha = await sha256Hex(bytes);
    const artifact_sealed = {
      ciphertext_funder_b64: sealTo(bytes, funder.publicKey),
      ciphertext_bridge_b64: sealTo(bytes, bridge.publicKey),
      artifact_sha256: `sha256:${sha}`,
    };
    const entry = await claimEntry(d.hash as string, artifact_sealed, sha);
    vi.stubGlobal("fetch", fetchRouter([
      ["/dg/oplog", () => jsonRes({ entries: [entry] })],
      ["proof.t16z", () => jsonRes({})],
      ["signature/", () => jsonRes({})],
    ]));
    const rec = await runReview(env, "widespread/writing", 1, { force: true });
    expect(rec.status).not.toBe("error");
    expect(rec.adjudication?.verdict).toBeDefined();
    // the judge adjudicated against the in-request-decrypted spec —
    // proof the bridge can judge what it never stores
    expect(specSeenByJudge).toContain("eulogy");
    const blob = JSON.stringify(rec);
    expect(blob).not.toContain("eulogy");
    expect(blob).not.toContain(DELIVERABLE);
    expect(rec.bounty?.spec).toBe("[confidential:writing]");
  });
});

// ------------------------------------------------------------- escrow
describe("D3 spec_sealed escrow binding", () => {
  it("escrow-plan uses the declared spec_hash — never sha256 of an empty spec", async () => {
    const kv = fakeKV();
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"], NEAR_CONTRACT: "mkt.testnet" } as Partial<Env>);
    const funder = newSealedKeyPair();
    const spec_hash = await specHashOf(SPEC);
    const d = await bountyDeclare(env, {
      spec_sealed: true, spec_hash, spec_cid: "bafySpecCid",
      reveal_endpoint: "https://funder.example/reveal",
      funder_x25519_pubkey: funder.publicKey, domain: "writing", amount: "50", capacity: CAP,
    });
    vi.stubGlobal("fetch", fetchRouter([["diadata", () => jsonRes({ Near: { Price: 3.5 } })]]));
    const plan = await declEscrowPlan(env, d.hash as string, { near_amount: "1" }) as Record<string, unknown>;
    const cm = plan.createMarket as { args: { specHash: string; spec: string } };
    expect(cm.args.specHash).toBe(spec_hash);
    expect(cm.args.spec).toContain("[confidential:writing]");
    expect(cm.args.spec).toContain("cid=bafySpecCid");
  });
});
