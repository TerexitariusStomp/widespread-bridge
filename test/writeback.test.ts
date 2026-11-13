import { describe, expect, it, vi, beforeEach } from "vitest";
import { writebackReceipt } from "../src/writeback";
import { fakeEnv, jsonRes } from "./mock";

const te = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (d: Uint8Array | string) =>
  hex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? te.encode(d) : d as BufferSource));

async function agentIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    env: {
      DG_AGENT_DID: "did:key:zTestAgent",
      DG_AGENT_KEY_PKCS8_B64: btoa(String.fromCharCode(...new Uint8Array(pkcs8))),
      FORGE_BASE: "https://code.widespread.fyi",
      PUBLIC_BASE: "https://widespread-bridge.widespread.workers.dev",
    },
    publicJwk: jwk,
  };
}

beforeEach(() => vi.unstubAllGlobals());

describe("writebackReceipt", () => {
  it("skips cleanly without agent identity", async () => {
    const w = await writebackReceipt(fakeEnv(), {
      repo: "o/r", sha: "abc", accepted: true, description: "d", claimId: "c1",
    });
    expect(w.attempted).toBe(false);
    expect(w.skipped_reason).toMatch(/DG_AGENT/);
  });

  it("produces a verifiable dg1-signed POST to /dg/status", async () => {
    const { env: idEnv, publicJwk } = await agentIdentity();
    const env = fakeEnv(idEnv);
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = init?.body;
      captured = {
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array),
      };
      return jsonRes({ ok: true });
    });
    const w = await writebackReceipt(env, {
      repo: "slop/slopdotcash", sha: "f".repeat(40), accepted: true,
      description: "adjudicated accept", claimId: "claim-1",
    });
    expect(w.attempted).toBe(true);
    expect(w.error).toBeUndefined();
    expect(w.status_url).toContain("/dg/status/");
    expect(captured!.url).toBe("https://code.widespread.fyi/api/slop/slopdotcash/dg/status");

    const h = captured!.headers;
    expect(h["x-dg-did"]).toBe("did:key:zTestAgent");
    const body = JSON.parse(captured!.body);
    expect(body.state).toBe("success");
    expect(body.context).toBe("widespread/payout");

    // Re-verify the signature exactly as the forge does:
    // sig = Ed25519( sha256("dg1\ndid\nts\nnonce\nPOST\npath\nsha256(body)") )
    const bodySha = await sha256(new TextEncoder().encode(captured!.body));
    const payload = await sha256(
      `dg1\ndid:key:zTestAgent\n${h["x-dg-ts"]}\n${h["x-dg-nonce"]}\nPOST\n/api/slop/slopdotcash/dg/status\n${bodySha}`);
    const key = await crypto.subtle.importKey("jwk", publicJwk, "Ed25519", false, ["verify"]);
    const sigBytes = Uint8Array.from(h["x-dg-sig"].match(/../g)!.map((x) => parseInt(x, 16)));
    const ok = await crypto.subtle.verify("Ed25519", key, sigBytes as BufferSource, te.encode(payload));
    expect(ok).toBe(true);
  });
});
