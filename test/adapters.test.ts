// adapters.test.ts — widespread-adapter/1 schema, id/signature
// verification, and the Python-plugin interop fixture (a manifest signed
// by the near-hermes-browser widespread_surfaces plugin must verify
// identically here — canonicalJson parity is load-bearing).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateAdapterManifest, verifyAdapterManifest, adapterId,
  adapterSignMessage, verifiedOpCount,
} from "../src/adapters";
import { didKeyFromPublicKey } from "../src/coordinator/didkey";

async function keypair() {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(pub, 2);
  const b58 = (await import("../src/coordinator/didkey")).base58Encode(prefixed);
  const hex = [...pub].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sign = async (msg: string) =>
    [...new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  return { did: `did:key:z${b58}`, pubHex: hex, sign };
}

async function manifest(k: Awaited<ReturnType<typeof keypair>>, over: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    schema: "widespread-adapter/1",
    surface: "example.com",
    kind: "social",
    author: k.did,
    auth: { type: "session-cookie", storage: "client-profile",
           refresh: "auto", delegation: "widespread-bind" },
    ops: [{ name: "list_mentions", class: "read", endpoint: "/api/mentions",
            method: "GET", verified: true, risk: "low",
            verify: { assert: "list-contains", evidence: "probe 2026-11" } }],
    grammar: { declaration: "#widespread bounty <hash>",
               claim: "widespread claim <hash>",
               receipt: "widespread receipt <id>", placement: "reply" },
    status: "verified",
    issued_at: 1700000000,
    ...over,
  };
  const id = await adapterId(body);
  const sig = await k.sign(adapterSignMessage(id));
  return { ...body, id, sig };
}

describe("widespread-adapter/1", () => {
  it("round-trips: sign → id → verify", async () => {
    const k = await keypair();
    const m = await manifest(k);
    const r = await verifyAdapterManifest(m);
    expect(r.ok).toBe(true);
    expect(verifiedOpCount(r.ok ? r.manifest : ({} as never))).toBe(1);
  });

  it("id covers every field except id/sig", async () => {
    const k = await keypair();
    const m = await manifest(k);
    const tampered = { ...m, surface: "other.com" };
    expect((await verifyAdapterManifest(tampered)).ok).toBe(false);
    const resigned = await manifest(k, { surface: "other.com" });
    expect(resigned.id).not.toBe(m.id);
    expect((await verifyAdapterManifest(resigned)).ok).toBe(true);
  });

  it("rejects verified ops without side-effect assert", async () => {
    const k = await keypair();
    const m = await manifest(k, {
      ops: [{ name: "x", class: "read", endpoint: "/x", method: "GET",
              verified: true, risk: "low" }] });
    const r = await verifyAdapterManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("verify.assert");
  });

  it("rejects non-http endpoints (no code execution in manifests)", async () => {
    const k = await keypair();
    for (const ep of ["javascript:alert(1)", "file:///etc/passwd", "//evil.com/x", "ftp://x"]) {
      const m = await manifest(k, {
        ops: [{ name: "x", class: "read", endpoint: ep, method: "GET",
                verified: false, risk: "low" }] });
      expect((await verifyAdapterManifest(m)).ok).toBe(false);
    }
  });

  it("rejects bad author did and duplicate op names", async () => {
    const k = await keypair();
    const badAuthor = await manifest(k, { author: "did:key:zNotAKey" });
    expect((await verifyAdapterManifest(badAuthor)).ok).toBe(false);
    const dup = await manifest(k, {
      ops: [
        { name: "x", class: "read", endpoint: "/a", method: "GET", verified: false, risk: "low" },
        { name: "x", class: "read", endpoint: "/b", method: "GET", verified: false, risk: "low" },
      ] });
    expect((await verifyAdapterManifest(dup)).ok).toBe(false);
  });

  it("plugin-signed fixture verifies identically (canonicalJson parity)", async () => {
    const m = JSON.parse(readFileSync(
      join(__dirname, "fixtures", "adapter-manifest.plugin.json"), "utf8"));
    const r = await verifyAdapterManifest(m);
    expect(r.ok).toBe(true);
  });
});
