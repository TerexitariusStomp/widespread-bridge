import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env, MirrorListing } from "../src/types";

const feedDocMock = vi.fn();
vi.mock("../src/feed", () => ({ feedDoc: (...a: unknown[]) => feedDocMock(...a) }));

import {
  handleMirrorClaimPost,
  handleMirrorVerdict, handleMirrorPayout,
} from "../src/mirrorclaims";
import { fakeEnv, fakeKV, fetchRouter, jsonRes } from "./mock";

const MIRROR: MirrorListing = {
  id: "mirror:test:1", record_id: "github-thirdparty:generic:o/r#1",
  title: "t", url: "https://x", repo: "o/r",
  original: { amount: "100", currency: "USD", est_usd: 100 },
  cut_bps: 1000, claimant_share: { est_usd: 90 },
  spec: "s", spec_hash: "sha256:spec",
  createMarketArgs: {}, status: "funded",
  funded_market_id: "7",
  created_at: 0, updated_at: 0,
};

function envWithEscrow(status = "confirmed") {
  const kv = fakeKV({
    [`escrowstate:${MIRROR.id}`]: JSON.stringify({ mirror_id: MIRROR.id,
      status, usd: "100", marketId: "7", attempts: 1, updated_at: 0 }),
  });
  return fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
}

const ghOk = () => fetchRouter([
  ["/issues/12", () => jsonRes({ number: 12, state: "open", title: "t",
    user: { id: 777, login: "bob" } })],
  ["/pulls/12/files", () => jsonRes([{ filename: "a.ts", status: "modified",
    patch: "@@ -1 +1 @@\n-x\n+y" }])],
]);

const post = (body: unknown) => new Request("https://x/api/mirrors/claims", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  feedDocMock.mockResolvedValue({ mirrors: [MIRROR], records: [] });
});

describe("handleMirrorClaimPost", () => {
  it("409s when mirror is not escrowed", async () => {
    feedDocMock.mockResolvedValue({ mirrors: [{ ...MIRROR, status: "seeking-funder" as const,
      funded_market_id: undefined }], records: [] });
    const env = envWithEscrow("pending");
    const res = await handleMirrorClaimPost(post({ mirror_id: MIRROR.id, forgeRef: "o/r#12" }), env);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not escrowed/);
  });

  it("201s an attested claim on an escrowed mirror", async () => {
    vi.stubGlobal("fetch", ghOk());
    const env = envWithEscrow();
    const res = await handleMirrorClaimPost(post({
      mirror_id: MIRROR.id, forgeRef: "https://github.com/o/r/pull/12",
      payout: { near_account: "w.near" },
    }), env);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.attested).toBe(true);
    expect(j.claim.forgeUserId).toBe("777");
    expect(j.claim.evidence.patch_fingerprint).toMatch(/^sha256:/);
  });

  it("422s on forge validation failure", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["api.github.com", () => new Response("nf", { status: 404 })],
    ]));
    const env = envWithEscrow();
    const res = await handleMirrorClaimPost(post({ mirror_id: MIRROR.id, forgeRef: "o/r#99" }), env);
    expect(res.status).toBe(422);
  });
});

async function fileClaim(env: Env) {
  vi.stubGlobal("fetch", ghOk());
  const res = await handleMirrorClaimPost(post({
    mirror_id: MIRROR.id, forgeRef: "https://github.com/o/r/pull/12",
    payout: { near_account: "w.near" },
  }), env);
  const j = await res.json();
  return j.claim.claim_hash as string;
}

describe("handleMirrorVerdict", () => {
  it("computes face/cut/net and records NEAR settlement", async () => {
    const env = envWithEscrow();
    const hash = await fileClaim(env);
    const res = await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: { near_account: "w.near" } }),
    }), env);
    const j = await res.json();
    expect(j.settlement.face_usd).toBe(100);
    expect(j.settlement.platform_cut_usd).toBe(10);
    expect(j.settlement.net_usd).toBe(90);
    expect(j.settlement.near.to).toBe("w.near");
    expect(j.settlement.near.market_id).toBe("7");
    expect(j.settlement.status).toBe("won");
  });

  it("is one-shot: second verdict returns already_decided", async () => {
    const env = envWithEscrow();
    const hash = await fileClaim(env);
    const mkReq = () => new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true }),
    });
    await handleMirrorVerdict(mkReq(), env);
    const res2 = await handleMirrorVerdict(mkReq(), env);
    const j2 = await res2.json();
    expect(j2.status).toBe("already_decided");
  });

  it("rejects unattested claims", async () => {
    const env = envWithEscrow();
    await env.CLAIMS.put(`mclaim:${MIRROR.id}:h1`, JSON.stringify({
      mirror_id: MIRROR.id, claim_hash: "h1", attested: false, status: "pending",
    }));
    const res = await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: "h1" }),
    }), env);
    expect(res.status).toBe(409);
  });
});

describe("handleMirrorPayout", () => {
  it("409s with no settlement", async () => {
    const res = await handleMirrorPayout(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    }), envWithEscrow());
    expect(res.status).toBe(409);
  });

  it("queues a NEAR release to the winner's claimant", async () => {
    const env = envWithEscrow();
    const hash = await fileClaim(env);
    await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: { near_account: "w.near" } }),
    }), env);
    const res = await handleMirrorPayout(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    }), env);
    const j = await res.json();
    expect(j.settlement.payout.rail).toBe("near-release");
    expect(j.settlement.payout.status).toBe("pending_ops");
    expect(j.settlement.payout.note).toContain("w.near");
  });

  it("dedupes: second payout while queued returns already_queued", async () => {
    const env = envWithEscrow();
    const hash = await fileClaim(env);
    await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: { near_account: "w.near" } }),
    }), env);
    const mkReq = () => new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    });
    await handleMirrorPayout(mkReq(), env);
    const res2 = await handleMirrorPayout(mkReq(), env);
    const j2 = await res2.json();
    expect(j2.status).toBe("already_queued");
    expect(j2.settlement.payout.status).toBe("pending_ops");
  });

  it("409s when the winner gave no NEAR claimant", async () => {
    const env = envWithEscrow();
    const hash = await fileClaim(env);
    await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: {} }),
    }), env);
    const res = await handleMirrorPayout(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    }), env);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no payout destination/);
  });
});
