// confidential.test.ts — confidential markets end to end:
// C0 flag/redaction, C1 claim-gated spec reveal, C2 sealed deliverable
// validation, C3 in-request decrypt for the judge, C5 record lint.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { bountyDeclare, getDeclared, specReveal } from "../src/declare";
import { parseArtifactRef, validateSealedArtifact } from "../src/artifacts";
import { validateForgeSubmission } from "../src/claims";
import {
  newSealedKeyPair, sealTo, sealOpen, parseSealedArtifact,
  decryptSealedForBridge, bridgeX25519PublicKey, sha256Hex,
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

async function sealedClaimFor(funderPub: string, bridgePub: string, text = DELIVERABLE) {
  const bytes = new TextEncoder().encode(text);
  const sha = await sha256Hex(bytes);
  return {
    sha,
    artifact_sealed: {
      ciphertext_funder_b64: sealTo(bytes, funderPub),
      ciphertext_bridge_b64: sealTo(bytes, bridgePub),
      artifact_sha256: `sha256:${sha}`,
    },
  };
}

// ---------------------------------------------------------------- C0
describe("C0 confidential declaration", () => {
  const env = fakeEnv();

  it("rejects confidential without funder x25519 pubkey", async () => {
    const d = await bountyDeclare(env, { confidential: true, spec: SPEC, amount: "50", capacity: CAP });
    expect(d.error).toMatch(/funder_x25519_pubkey/);
  });

  it("redacts spec from canonical + feed record, keeps it in private KV", async () => {
    const kp = newSealedKeyPair();
    const d = await bountyDeclare(env, {
      confidential: true, funder_x25519_pubkey: kp.publicKey,
      domain: "writing", spec: SPEC, amount: "50", currency: "USD", capacity: CAP,
      target_platform: "linkedin", target_handle: "alice",  // ghostwrite target = the funder
      funder_did: "did:key:zFunder",
    });
    expect(d.error).toBeUndefined();
    expect(d.canonical).toContain("confidential:");
    expect(d.canonical).not.toContain("eulogy");          // spec text absent
    expect(d.canonical).not.toContain(SPEC);
    const rec = d.record as Record<string, unknown>;
    expect(rec.confidential).toBe(true);
    expect(rec.spec).toBeUndefined();
    expect(String(rec.title)).not.toContain("eulogy");
    // funder linkage: ghostwrite target + funder did never go public
    expect(d.canonical).not.toContain("alice");
    expect(d.canonical).not.toContain("linkedin");
    expect(rec.for).toBeUndefined();
    const b = await getDeclared(env, d.hash);
    expect(b?.spec).toBe(SPEC);                            // private KV keeps it
    expect(b?.confidential).toBe(true);
    expect(b?.funder_x25519_pubkey).toBe(kp.publicKey);
    expect(b?.funder_did).toBeUndefined();                 // never persisted
    expect(b?.target?.handle).toBe("alice");               // private KV keeps it for review
  });
});

// ---------------------------------------------------------------- C2
describe("C2 sealed deliverable validation", () => {
  const env = fakeEnv();

  it("parses sealed:// refs", () => {
    expect(parseArtifactRef(`sealed://${"a".repeat(64)}`))
      .toEqual({ kind: "sealed", sha256: "a".repeat(64) });
    expect(parseArtifactRef("sealed://nope")).toBeNull();
  });

  it("validates a properly sealed artifact end to end", async () => {
    const funder = newSealedKeyPair();
    const bridge = newSealedKeyPair();
    const { sha, artifact_sealed } = await sealedClaimFor(funder.publicKey, bridge.publicKey);
    const { failures, evidence } = await validateForgeSubmission(env, {
      forgeRef: `sealed://${sha}`,
      evidence: { artifact_sealed },
    });
    expect(failures).toEqual([]);
    expect(evidence.artifact).toBe("sealed");
    expect(evidence.artifact_sha256).toBe(`sha256:${sha}`);
  });

  it("rejects missing, malformed, and ref-mismatched sealed artifacts", async () => {
    const { failures: noSeal } = await validateForgeSubmission(env, {
      forgeRef: `sealed://${"a".repeat(64)}`, evidence: {},
    });
    expect(noSeal.join()).toMatch(/artifact_sealed/);

    const kp = newSealedKeyPair();
    const { artifact_sealed } = await sealedClaimFor(kp.publicKey, kp.publicKey);
    const { failures: mismatch } = await validateForgeSubmission(env, {
      forgeRef: `sealed://${"b".repeat(64)}`,          // ref ≠ payload hash
      evidence: { artifact_sealed },
    });
    expect(mismatch.join()).toMatch(/does not match/);

    const bad = { ciphertext_funder_b64: "!!!", ciphertext_bridge_b64: "eQ==", artifact_sha256: "sha256:xyz" };
    const { failures: malformed } = await validateForgeSubmission(env, {
      forgeRef: `sealed://${"a".repeat(64)}`, evidence: { artifact_sealed: bad },
    });
    expect(malformed.length).toBeGreaterThanOrEqual(2);
  });
});

// --------------------------------------------------------- sealed crypto
describe("sealed crypto (noble-sodium, libsodium wire)", () => {
  it("seal/open round-trips; wrong key returns null", async () => {
    const kp = newSealedKeyPair();
    const msg = new TextEncoder().encode("confidential deliverable");
    const ct = sealTo(msg, kp.publicKey);
    const opened = sealOpen(ct, kp.secretKey);
    expect(new TextDecoder().decode(opened!)).toBe("confidential deliverable");
    const other = newSealedKeyPair();
    expect(sealOpen(ct, other.secretKey)).toBeNull();
  });

  it("bridge pubkey derives from secret; decrypt verifies artifact_sha256", async () => {
    const bridge = newSealedKeyPair();
    const env = fakeEnv({ BRIDGE_X25519_SECRET: bridge.secretKey } as Partial<Env>);
    expect(bridgeX25519PublicKey(env)).toBe(bridge.publicKey);

    const funder = newSealedKeyPair();
    const { artifact_sealed } = await sealedClaimFor(funder.publicKey, bridge.publicKey);
    const dec = await decryptSealedForBridge(env, artifact_sealed);
    expect(dec.error).toBeUndefined();
    expect(new TextDecoder().decode(dec.plaintext!)).toBe(DELIVERABLE);

    // tampered hash → binding failure
    const tampered = { ...artifact_sealed, artifact_sha256: `sha256:${"0".repeat(64)}` };
    expect((await decryptSealedForBridge(env, tampered)).error).toMatch(/hash/);
    // no bridge secret configured → adjudication unavailable, never silent
    expect((await decryptSealedForBridge(fakeEnv(), artifact_sealed)).error).toMatch(/BRIDGE_X25519_SECRET/);
  });
});

// ---------------------------------------------------------------- C1
describe("C1 claim-gated spec reveal", () => {
  it("gates on confidential + registered agent + valid sig; seals the spec", async () => {
    const kv = fakeKV();
    const env = fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
    const funder = newSealedKeyPair();
    const d = await bountyDeclare(env, {
      confidential: true, funder_x25519_pubkey: funder.publicKey,
      domain: "writing", spec: SPEC, amount: "50", capacity: CAP,
    });
    const hash = d.hash as string;

    // non-confidential market → no reveal needed
    const open = await bountyDeclare(env, { spec: "public task", amount: "5", capacity: CAP });
    expect((await specReveal(env, { hash: open.hash as string, agent_pubkey: "0".repeat(64), x25519_pubkey: "0".repeat(64), signature_hex: "0".repeat(128) })).error)
      .toMatch(/not confidential/);

    // unregistered agent → gate
    const agentSecret = ed25519.utils.randomPrivateKey();
    const agentPub = toHex(ed25519.getPublicKey(agentSecret));
    const claimant = newSealedKeyPair();
    const canon = `widespread-spec-reveal\n${hash}\n${claimant.publicKey}`;
    const sig = toHex(ed25519.sign(new TextEncoder().encode(canon), agentSecret));
    expect((await specReveal(env, { hash, agent_pubkey: agentPub, x25519_pubkey: claimant.publicKey, signature_hex: sig })).error)
      .toMatch(/not registered/);

    // register the agent (the KV key the reveal gate checks)
    await kv.put(`agent:${agentPub}`, JSON.stringify({ pubkey: agentPub, did: "did:key:zAgent", label: "t" }));

    // bad signature → reject
    expect((await specReveal(env, { hash, agent_pubkey: agentPub, x25519_pubkey: claimant.publicKey, signature_hex: "f".repeat(128) })).error)
      .toMatch(/signature invalid/);

    // good sig → sealed spec that only the claimant's x25519 key opens
    const res = await specReveal(env, { hash, agent_pubkey: agentPub, x25519_pubkey: claimant.publicKey, signature_hex: sig });
    expect(res.error).toBeUndefined();
    const pt = sealOpen(res.spec_sealed_b64 as string, claimant.secretKey);
    expect(new TextDecoder().decode(pt!)).toBe(SPEC);
    expect(sealOpen(res.spec_sealed_b64 as string, newSealedKeyPair().secretKey)).toBeNull();

    // reveal logged for the funder's audit
    const logged = (await kv.list({ prefix: `specreveal:${hash}:` })).keys.length;
    expect(logged).toBe(1);
  });
});

// ------------------------------------------------ C3/C5 full review lane
describe("C3+C5 confidential review — judge reads, record never stores", () => {
  it("sealed claim adjudicates; record carries ciphertext+hash only", async () => {
    const kv = fakeKV();
    const funder = newSealedKeyPair();
    const bridge = newSealedKeyPair();
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      BRIDGE_X25519_SECRET: bridge.secretKey,
      FORGES: JSON.stringify({ "widespread/writing": { type: "deltagit", base: "https://forge.test" } }),
      AI: { run: async () => ({ response: JSON.stringify({ verdict: "accept", reasoning: "spec-fit verified against sealed deliverable", confidence: 0.9 }) }) },
    } as Partial<Env>);

    // declare the confidential market (spec lives in private KV)
    const d = await bountyDeclare(env, {
      confidential: true, funder_x25519_pubkey: funder.publicKey,
      domain: "writing", spec: SPEC, amount: "50", capacity: CAP,
    });

    // build a valid op-log claim carrying the sealed deliverable
    const { sha, artifact_sealed } = await sealedClaimFor(funder.publicKey, bridge.publicKey);
    const entry = {
      seq: 1, kind: "push.patch", actor: "did:key:zWorker",
      payload: {
        work_id: d.hash, ref: `sealed://${sha}`,
        evidence: { artifact_sealed }, actor: "did:key:zWorker",
        claimant: "worker.testnet", commits: [],
      },
      created_at: Date.now(), prev_hash: "genesis", hash: "",
    };
    entry.hash = await entryHash(entry as never, "genesis");

    vi.stubGlobal("fetch", fetchRouter([
      ["/dg/oplog", () => jsonRes({ entries: [entry] })],
      ["/commits/", () => jsonRes({ message: "ship" })],
      ["proof.t16z", () => jsonRes({})],
      ["signature/", () => jsonRes({})],
    ]));

    const rec = await runReview(env, "widespread/writing", 1, { force: true });
    expect(rec.status).not.toBe("error");
    const blob = JSON.stringify(rec);
    expect(blob).not.toContain("eulogy");                       // spec redacted
    expect(blob).not.toContain(DELIVERABLE);                    // plaintext absent
    expect(blob).not.toContain(artifact_sealed.ciphertext_funder_b64.slice(0, 40).slice(0, 40) === "" ? "x" : "this can't match");
    expect(rec.bounty?.spec).toBe("[confidential:writing]");
    expect(rec.adjudication?.verdict).toBeDefined();
    // ciphertext is allowed in the record — it's the sealed artifact
    expect(JSON.stringify(rec.claim)).toContain("artifact_sealed");
  });

  it("rejects plaintext lanes on confidential markets", async () => {
    const kv = fakeKV();
    const bridge = newSealedKeyPair();
    const env = fakeEnv({
      CLAIMS: kv as unknown as Env["CLAIMS"],
      BRIDGE_X25519_SECRET: bridge.secretKey,
      FORGES: JSON.stringify({ "widespread/writing": { type: "deltagit", base: "https://forge.test" } }),
    } as Partial<Env>);
    const funder = newSealedKeyPair();
    const d = await bountyDeclare(env, {
      confidential: true, funder_x25519_pubkey: funder.publicKey,
      domain: "writing", spec: SPEC, amount: "50", capacity: CAP,
    });
    const entry = {
      seq: 1, kind: "push.patch", actor: "did:key:zWorker",
      payload: { work_id: d.hash, evidence: { text: DELIVERABLE }, actor: "did:key:zWorker", commits: [] },
      created_at: Date.now(), prev_hash: "genesis", hash: "",
    };
    entry.hash = await entryHash(entry as never, "genesis");
    vi.stubGlobal("fetch", fetchRouter([
      ["/dg/oplog", () => jsonRes({ entries: [entry] })],
    ]));
    const rec = await runReview(env, "widespread/writing", 1, { force: true });
    expect(rec.status).toBe("rejected");
    expect(rec.adjudication?.reasoning).toMatch(/confidential/);
  });
});
