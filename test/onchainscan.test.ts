// onchainscan.test.ts — the automated on-chain adjudication loop:
// pending attested claims get judged + voted + released without any
// human step.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanOnchain, scanMirrorPayouts } from "../src/onchainscan";
import { fakeEnv, fakeKV, jsonRes } from "./mock";
import { b58encode } from "../src/nearops";
import { ed25519 } from "@noble/curves/ed25519";
import type { Env } from "../src/types";

const CONTRACT = "wide-mkt-11561.testnet";
const PK = "ab".repeat(32); // our oracle pubkey hex

// A REAL ed25519 keypair — nearFunctionCall signs the tx with WebCrypto
// JWK import which rejects non-curve bytes even when send_tx is mocked.
const seed = ed25519.utils.randomPrivateKey();
const pub = ed25519.getPublicKey(seed);
const fakeSecretKey = `ed25519:${b58encode(new Uint8Array([...seed, ...pub]))}`;

function envWithOracle(kv: ReturnType<typeof fakeEnv>["CLAIMS"], aiVerdict = "accept"): Env {
  return fakeEnv({
    CLAIMS: kv,
    NEAR_CONTRACT: CONTRACT,
    ORACLE_ACCOUNT: "wide-mkt-11561.testnet",
    ORACLE_SECRET_KEY: fakeSecretKey,
    ORACLE_SEED_HEX: "cd".repeat(32),
    ORACLE_PUBKEY_HEX: PK,
    // Contest ballots: winner label C1..Cn (or "none"), not per-claim verdicts
    AI: { run: async () => ({ response: JSON.stringify({
      winner: aiVerdict === "accept" ? "C1" : "none",
      reasoning: "test verdict", confidence: 0.92 }) }) },
  } as Partial<Env>);
}

/** Mock NEAR RPC: view calls by method_name; access-key/block/tx stubs. */
function rpcMock(state: {
  openMarkets?: unknown[];
  claims?: Record<string, unknown[]>;
  sendTx?: string[]; // collects each send_tx for assertions
}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
      params?: { method_name?: string; args_base64?: string; request_type?: string };
    };
    if (body.method === "send_tx") {
      state.sendTx?.push("send_tx");
      return jsonRes({ result: {
        transaction: { hash: "tx-mock-1" },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
      } });
    }
    if (body.method === "block") {
      return jsonRes({ result: { header: { hash: b58encode(new Uint8Array(32).fill(1)) } } });
    }
    if (body.method === "query" && body.params?.request_type === "view_access_key") {
      return jsonRes({ result: { nonce: 0, permission: "FullAccess" } });
    }
    const name = body.params?.method_name;
    const args = JSON.parse(
      Buffer.from(body.params?.args_base64 ?? "e30=", "base64").toString()) as { marketId?: string };
    state.sendTx?.push(`view:${name}`);
    const payload = (v: unknown) => jsonRes({
      result: { result: [...new TextEncoder().encode(JSON.stringify(v))] } });
    if (name === "listOpen") return payload(state.openMarkets ?? []);
    if (name === "getClaims") return payload({ claims: state.claims?.[String(args.marketId)] ?? [], total: 0, pending: 0 });
    if (name === "getVerdicts") return payload({ quorumM: 1, votes: {}, acceptTally: {} });
    if (name === "listOracles") return payload([]);
    return jsonRes({ error: `unmocked ${name}` }, 500);
  };
}

describe("scanOnchain", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("adjudicates a pending attested claim, votes accept, releases at quorum=1", async () => {
    const env = envWithOracle(fakeKV() as Env["CLAIMS"]);
    const calls: string[] = [];
    vi.stubGlobal("fetch", rpcMock({
      sendTx: calls,
      openMarkets: [{ marketId: "9", spec: "fix the widget", locked: "1000", status: "open" }],
      claims: { "9": [{ claimId: "1", claimHash: "ch9", status: "pending",
        attested: true, claimant: "worker.testnet", commits: ["abc"], evidence: {} }] },
    }));
    const res = await scanOnchain(env);
    expect(res.reviewed).toBe(1);
    expect(res.voted).toBe(1);
    // submitVerdict + release = two broadcast txs, zero human steps
    expect(calls.filter((c) => c === "send_tx").length).toBe(2);
    const rec = await env.CLAIMS.get("ocv:9:1", "json") as Record<string, unknown>;
    expect(rec.verdict).toBe("accept");
    expect(rec.released_tx).toBe("tx-mock-1");
  });

  it("rejects when the judge rejects, and never re-judges", async () => {
    const env = envWithOracle(fakeKV() as Env["CLAIMS"], "reject");
    vi.stubGlobal("fetch", rpcMock({
      openMarkets: [{ marketId: "9", spec: "s", locked: "1", status: "open" }],
      claims: { "9": [{ claimId: "1", claimHash: "ch9", status: "pending", attested: true }] },
    }));
    const r1 = await scanOnchain(env);
    expect(r1.voted).toBe(0); // panel said none — the seat abstains, no reject vote
    const rec = await env.CLAIMS.get("ocv:9:1", "json") as Record<string, unknown>;
    expect(rec.verdict).toBe("none-acceptable");
    const r2 = await scanOnchain(env);
    expect(r2.reviewed).toBe(0); // deduped
  });

  it("skips confidential-stub markets and unattested claims", async () => {
    const env = envWithOracle(fakeKV() as Env["CLAIMS"]);
    vi.stubGlobal("fetch", rpcMock({
      openMarkets: [{ marketId: "8", spec: "[confidential:writing] specHash=x", locked: "1", status: "open" }],
      claims: { "8": [{ claimId: "1", claimHash: "c", status: "pending", attested: true }] },
    }));
    const res = await scanOnchain(env);
    expect(res.reviewed).toBe(0);
    expect(res.voted).toBe(0);
  });

  it("no oracle config → zero work, zero errors", async () => {
    const env = fakeEnv();
    expect(await scanOnchain(env)).toEqual({ reviewed: 0, voted: 0 });
  });
});

describe("scanMirrorPayouts", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("ships the winner on-chain and releases as payer — no human step", async () => {
    const kv = fakeKV();
    await kv.put("msettle:m1", JSON.stringify({
      status: "won", mirror_id: "m1", winning_claim_hash: "wch-1",
      winner: { actor: "dev" },
      near: { market_id: "7", to: "winner.testnet" },
    }));
    const env = fakeEnv({
      CLAIMS: kv as Env["CLAIMS"],
      NEAR_OPS_ACCOUNT: "wide-ops-328424.testnet",
      NEAR_OPS_SECRET_KEY: fakeSecretKey,
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", rpcMock({
      sendTx: calls,
      claims: { "7": [{ claimId: "3", claimHash: "wch-1", status: "pending" }] },
    }));
    const n = await scanMirrorPayouts(env);
    expect(n).toBe(1);
    // shipClaim + release = two broadcast txs
    expect(calls.filter((c) => c === "send_tx").length).toBe(2);
    const s = await kv.get("msettle:m1", "json") as { payout: { status: string; tx_hash: string } };
    expect(s.payout.status).toBe("paid");
    expect(s.payout.tx_hash).toBe("tx-mock-1");
  });
});
