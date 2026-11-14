import { describe, expect, it, vi, beforeEach } from "vitest";
import { canonicalJson as discoveryCanonicalJson } from "../widespread-discovery/src/core.mjs";
import {
  parseArtifactRef, isCid, validateCidArtifact, validateReceipt,
  receiptCanonical, receiptId, meterSpec, verifyJobRecordSig, canonicalJson,
  type MeteredReceipt,
} from "../src/artifacts";
import { validateForgeSubmission } from "../src/claims";
import { verifyUpstreamRef } from "../src/upstream";
import { didKeyFromPublicKey, didKeyPublicKey } from "../src/coordinator/didkey";
import { fakeEnv, fetchRouter, jsonRes } from "./mock";

beforeEach(() => vi.unstubAllGlobals());

const CID_V0 = "QmYwAPJzv5CZsnAzt8auVZRn5hVfFq8m2Yd8o8t6m2Yd8o"; // shape-valid v0
const CID_V1 = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

describe("parseArtifactRef", () => {
  it("parses github refs (compat with parseForgeRef)", () => {
    expect(parseArtifactRef("https://github.com/o/r/pull/12"))
      .toEqual({ kind: "github", owner: "o", repo: "r", issueKind: "pr", number: 12 });
    expect(parseArtifactRef("o/r#7"))
      .toEqual({ kind: "github", owner: "o", repo: "r", issueKind: "issue", number: 7 });
  });
  it("parses btfs:// and ipfs:// CIDs", () => {
    expect(parseArtifactRef(`btfs://${CID_V1}`))
      .toEqual({ kind: "cid", scheme: "btfs", cid: CID_V1 });
    expect(parseArtifactRef(`ipfs://${CID_V0}`))
      .toEqual({ kind: "cid", scheme: "ipfs", cid: CID_V0 });
  });
  it("parses gateway URLs", () => {
    const r = parseArtifactRef(`https://ipfs.io/ipfs/${CID_V1}`);
    expect(r).toEqual({ kind: "cid", scheme: "ipfs", cid: CID_V1 });
  });
  it("parses rcpt:// receipts", () => {
    expect(parseArtifactRef("rcpt://rcpt-abc123"))
      .toEqual({ kind: "receipt", receiptId: "rcpt-abc123" });
  });
  it("parses coordinator job refs", () => {
    expect(parseArtifactRef("job:job-9f2")).toEqual({ kind: "job", jobId: "job-9f2" });
    expect(parseArtifactRef("widespread://job/job-9f2")).toEqual({ kind: "job", jobId: "job-9f2" });
    expect(parseArtifactRef("https://x.dev/api/jobs/job-9f2")).toEqual({ kind: "job", jobId: "job-9f2" });
  });
  it("rejects malformed refs", () => {
    expect(parseArtifactRef("btfs://notacid!")).toBeNull();
    expect(parseArtifactRef("random text")).toBeNull();
    expect(isCid("notacid!")).toBe(false);
    expect(isCid(CID_V0)).toBe(true);
    expect(isCid(CID_V1)).toBe(true);
  });
});

describe("validateCidArtifact", () => {
  const cidRef = { kind: "cid" as const, scheme: "btfs" as const, cid: CID_V1 };

  it("verifies inline content by sha256 (no network)", async () => {
    const payload = btoa("hello artifact");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello artifact"));
    const sha = `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const { failures, evidence } = await validateCidArtifact(fakeEnv(), cidRef,
      { artifact_inline: payload, artifact_sha256: sha });
    expect(failures).toEqual([]);
    expect(evidence.inline_verified).toBe(true);
    expect(evidence.artifact_sha256).toBe(sha);
  });

  it("fails when declared hash mismatches inline content", async () => {
    const { failures } = await validateCidArtifact(fakeEnv(), cidRef,
      { artifact_inline: btoa("x"), artifact_sha256: "sha256:" + "0".repeat(64) });
    expect(failures[0]).toMatch(/does not match/);
  });

  it("resolves via gateway when content exists", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      [`https://gateway.btfs.io/btfs/${CID_V1}`, () => new Response(null, { status: 200 })],
    ]));
    const { failures, evidence } = await validateCidArtifact(fakeEnv(), cidRef, {});
    expect(failures).toEqual([]);
    expect(evidence.resolved).toBe(true);
  });

  it("fails honestly when no gateway resolves", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["*", () => new Response(null, { status: 404 })],
    ]));
    const { failures } = await validateCidArtifact(fakeEnv(), cidRef, {});
    expect(failures[0]).toMatch(/not resolvable/);
  });
});

// --- receipts --------------------------------------------------------------

/** Mirror of the runner's signReceipt: id = sha256(canonicalJson(body)),
 * sig = ed25519 over `widespread-receipt:<id>`, fields pubkey+sig hex. */
async function signReceipt(
  body: Record<string, unknown>, priv: CryptoKey, pub: Uint8Array,
): Promise<MeteredReceipt> {
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(canonicalJson(body)));
  const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sig = await crypto.subtle.sign("Ed25519", priv,
    new TextEncoder().encode(`widespread-receipt:${id}`));
  return {
    ...body, id,
    pubkey: [...pub].map((b) => b.toString(16).padStart(2, "0")).join(""),
    sig: [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  } as MeteredReceipt;
}

async function makeReceipt(over: Record<string, unknown> = {}) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const node_did = didKeyFromPublicKey(pub);
  const body = {
    v: 1, market: "mkt-1", node_did, meter_kind: "bandwidth_gb",
    units: { bandwidth_gb: 12.5 }, period_secs: 604800,
    upstream_refs: ["mysterium:sess-abc123"], issued_at: Math.floor(Date.now() / 1000),
    ...over,
  };
  return { receipt: await signReceipt(body, pair.privateKey, pub), pair, node_did };
}

const RESOURCE_MARKET = { spec: "serve exit bandwidth meter:bandwidth_gb threshold:10 window:7d" };

describe("meterSpec", () => {
  it("parses meter/threshold/window tokens from spec text", () => {
    expect(meterSpec(RESOURCE_MARKET)).toEqual({
      meter: "bandwidth_gb", threshold: 10, window_secs: 604800,
    });
  });
  it("honors verification.params over spec text", () => {
    expect(meterSpec({ spec: "", verification: { params: { meter: "tokens", threshold: 1e6 } } }))
      .toEqual({ meter: "tokens", threshold: 1e6, window_secs: null });
  });
});

describe("validateReceipt", () => {
  const refFor = (receipt: MeteredReceipt) =>
    ({ kind: "receipt" as const, receiptId: receipt.id });

  it("accepts a signed receipt at threshold with upstream refs", async () => {
    const { receipt } = await makeReceipt();
    const { failures, evidence } = await validateReceipt(fakeEnv(), refFor(receipt), RESOURCE_MARKET, { receipt });
    expect(failures).toEqual([]);
    expect(evidence.sig_verified).toBe(true);
    expect(evidence.device_did).toBe(receipt.node_did);
    expect(evidence.metering_confidence).toBe("upstream-referenced");
  });

  it("rejects a forged signature", async () => {
    const { receipt } = await makeReceipt();
    const forged = { ...receipt, units: { bandwidth_gb: 9999 } }; // mutate after signing
    const { failures } = await validateReceipt(fakeEnv(), refFor(receipt), RESOURCE_MARKET, { receipt: forged });
    expect(failures[0]).toMatch(/signature does not verify/);
  });

  it("rejects below-threshold metering", async () => {
    const { receipt } = await makeReceipt({ units: { bandwidth_gb: 3 } });
    const { failures } = await validateReceipt(fakeEnv(), refFor(receipt), RESOURCE_MARKET, { receipt });
    expect(failures[0]).toMatch(/below market threshold/);
  });

  it("rejects self-reported metering with no corroboration", async () => {
    const { receipt } = await makeReceipt({ upstream_refs: [] });
    const { failures } = await validateReceipt(fakeEnv(), refFor(receipt), RESOURCE_MARKET, { receipt });
    expect(failures.some((f) => /unverifiable metering/.test(f))).toBe(true);
  });

  it("rejects when market declares no measurable threshold", async () => {
    const { receipt } = await makeReceipt();
    const { failures } = await validateReceipt(fakeEnv(), refFor(receipt), { spec: "do good work" }, { receipt });
    expect(failures[0]).toMatch(/no measurable threshold/);
  });

  it("rejects a ref whose id doesn't match the receipt body", async () => {
    const { receipt } = await makeReceipt();
    const { failures } = await validateReceipt(
      fakeEnv(), { kind: "receipt", receiptId: "f".repeat(64) }, RESOURCE_MARKET, { receipt });
    expect(failures[0]).toMatch(/does not match ref/);
  });

  it("did:key roundtrips pubkey encode/decode", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const did = didKeyFromPublicKey(pub);
    expect(did.startsWith("did:key:z")).toBe(true);
    expect(didKeyPublicKey(did)).toEqual(pub);
  });
});

describe("upstream provers", () => {
  it("validates ref formats per network", async () => {
    const good = await verifyUpstreamRef(fakeEnv(), "mysterium:sess-abc123");
    expect(good.network).toBe("mysterium");
    const bad = await verifyUpstreamRef(fakeEnv(), "mysterium:not a session!");
    expect(bad.detail).toMatch(/format check/);
    const unknown = await verifyUpstreamRef(fakeEnv(), "fakenet:abc");
    expect(unknown.network).toBe("unknown");
  });
  it("networks without public APIs report honestly unverified", async () => {
    const v = await verifyUpstreamRef(fakeEnv(), "mysterium:12345678-1234-1234-1234-123456789abc");
    expect(v.verified).toBe(false);
    expect(v.detail).toMatch(/no public proof/);
  });
});

describe("job records", () => {
  it("verifies hmac-sha256 job record signatures (canonical JSON)", async () => {
    const secret = "test-attest-secret";
    const record = { jobId: "j1", taskType: 400, status: "done", results: [{ volunteer: "v1", did: "did:key:z6Mk", result: "{}" }] };
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(record)));
    const signed = { ...record, sig: `hmac-sha256:${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}` };
    expect(await verifyJobRecordSig(fakeEnv(), signed)).toBe(true);
    expect(await verifyJobRecordSig(fakeEnv(), { ...signed, status: "failed" })).toBe(false);
    // unsigned record fails when a secret is configured
    expect(await verifyJobRecordSig(fakeEnv(), { ...record, sig: null })).toBe(false);
  });
});

describe("validateForgeSubmission dispatch", () => {
  it("routes btfs:// refs to CID validation", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      [`https://gateway.btfs.io/btfs/${CID_V1}`, () => new Response(null, { status: 200 })],
    ]));
    const { failures, evidence } = await validateForgeSubmission(fakeEnv(), { forgeRef: `btfs://${CID_V1}` });
    expect(evidence.artifact_kind).toBe("cid");
    expect(evidence.cid).toBe(CID_V1);
    expect(failures).toEqual([]);
  });
  it("routes rcpt:// refs to receipt validation", async () => {
    const { receipt } = await makeReceipt();
    const { failures } = await validateForgeSubmission(fakeEnv(), {
      forgeRef: `rcpt://${receipt.id}`, evidence: { receipt },
      market: RESOURCE_MARKET,
    });
    expect(failures).toEqual([]);
  });
  it("github refs still work", async () => {
    const { failures } = await validateForgeSubmission(fakeEnv(), { forgeRef: "bogus" });
    expect(failures[0]).toMatch(/forgeRef must be/);
  });
});

// canonicalJson must stay byte-identical across runtimes — the worker,
// discovery node, and watchers all sign/verify the same encodings.
describe("canonicalJson cross-runtime parity", () => {
  const FIXTURES = [
    { b: 1, a: { z: [3, 2, 1], y: "x" }, nested: { deep: { k: null } } },
    [1, "two", { three: 3, arr: [{ x: true }], nil: null }],
    "plain string", 42, null, [], {},
    { unicode: "café ☕", esc: 'a"b\\c', num: -0.5e3 },
  ];
  it("worker and discovery implementations emit identical bytes", () => {
    for (const f of FIXTURES) {
      expect(canonicalJson(f)).toBe(discoveryCanonicalJson(f));
    }
  });
});
