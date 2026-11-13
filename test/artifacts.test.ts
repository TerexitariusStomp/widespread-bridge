import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseArtifactRef, isCid, validateCidArtifact, validateReceipt,
  receiptCanonical, meterSpec, verifyJobRecordSig,
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

async function signReceipt(
  payload: Omit<MeteredReceipt, "sig_hex">, priv: CryptoKey,
): Promise<MeteredReceipt> {
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)));
  const digestHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const canonical = `widespread-receipt\n${payload.id}\n${digestHex}`;
  const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(canonical));
  return { ...payload, sig_hex: [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

async function makeReceipt(over: Partial<MeteredReceipt> = {}) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const node_did = didKeyFromPublicKey(pub);
  const payload: Omit<MeteredReceipt, "sig_hex"> = {
    id: "rcpt-test-1", node_did, meter_kind: "bandwidth_gb",
    units: { bandwidth_gb: 12.5 }, period_secs: 604800,
    upstream_refs: ["mysterium:sess-abc123"], issued_at: Date.now(),
    ...over,
  };
  return { receipt: await signReceipt(payload, pair.privateKey), pair, node_did };
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
  const rcptRef = { kind: "receipt" as const, receiptId: "rcpt-test-1" };

  it("accepts a signed receipt at threshold with upstream refs", async () => {
    const { receipt } = await makeReceipt();
    const { failures, evidence } = await validateReceipt(fakeEnv(), rcptRef, RESOURCE_MARKET, { receipt });
    expect(failures).toEqual([]);
    expect(evidence.sig_verified).toBe(true);
    expect(evidence.device_did).toBe(receipt.node_did);
    expect(evidence.metering_confidence).toBe("upstream-referenced");
  });

  it("rejects a forged signature", async () => {
    const { receipt } = await makeReceipt();
    const forged = { ...receipt, units: { bandwidth_gb: 9999 } }; // mutate after signing
    const { failures } = await validateReceipt(fakeEnv(), rcptRef, RESOURCE_MARKET, { receipt: forged });
    expect(failures[0]).toMatch(/signature does not verify/);
  });

  it("rejects below-threshold metering", async () => {
    const { receipt } = await makeReceipt({ units: { bandwidth_gb: 3 } });
    const { failures } = await validateReceipt(fakeEnv(), rcptRef, RESOURCE_MARKET, { receipt });
    expect(failures[0]).toMatch(/below market threshold/);
  });

  it("rejects self-reported metering with no corroboration", async () => {
    const { receipt } = await makeReceipt({ upstream_refs: [] });
    const { failures } = await validateReceipt(fakeEnv(), rcptRef, RESOURCE_MARKET, { receipt });
    expect(failures.some((f) => /unverifiable metering/.test(f))).toBe(true);
  });

  it("rejects when market declares no measurable threshold", async () => {
    const { receipt } = await makeReceipt();
    const { failures } = await validateReceipt(fakeEnv(), rcptRef, { spec: "do good work" }, { receipt });
    expect(failures[0]).toMatch(/no measurable threshold/);
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
  it("verifies HMAC job record signatures", async () => {
    const secret = "test-attest-secret";
    const record = { jobId: "j1", taskType: 400, status: "done", results: [{ volunteer: "v1", did: "did:key:z6Mk", result: "{}" }] };
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(record)));
    const signed = { ...record, sig: [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    expect(await verifyJobRecordSig(fakeEnv(), signed)).toBe(true);
    expect(await verifyJobRecordSig(fakeEnv(), { ...signed, status: "failed" })).toBe(false);
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
      forgeRef: "rcpt://rcpt-test-1", evidence: { receipt },
      market: RESOURCE_MARKET,
    });
    expect(failures).toEqual([]);
  });
  it("github refs still work", async () => {
    const { failures } = await validateForgeSubmission(fakeEnv(), { forgeRef: "bogus" });
    expect(failures[0]).toMatch(/forgeRef must be/);
  });
});
