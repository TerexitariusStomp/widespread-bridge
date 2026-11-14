// disputes.test.ts — D4 appeal layer: dispute plans are trustless (the
// disputer's bond, their key), the docket is public, evidence bundles
// carry the on-chain record, and interim rulings sign on-chain.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { disputePlan, getDisputes, evidenceBundle, submitRuling } from "../src/disputes";
import { fakeEnv, fakeKV, jsonRes } from "./mock";
import { b58encode } from "../src/nearops";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Env } from "../src/types";

beforeEach(() => vi.unstubAllGlobals());

const CONTRACT = "mkt.testnet";
const seed = ed25519.utils.randomSecretKey();
const pub = ed25519.getPublicKey(seed);
const fakeSecretKey = `ed25519:${b58encode(new Uint8Array([...seed, ...pub]))}`;

function env() {
  return fakeEnv({
    NEAR_CONTRACT: CONTRACT,
    ORACLE_ACCOUNT: "contract.testnet",
    ORACLE_SECRET_KEY: fakeSecretKey,
    ORACLE_SEED_HEX: "cd".repeat(32),
    ORACLE_PUBKEY_HEX: "ab".repeat(32),
    CLAIMS: fakeKV(),
  } as Partial<Env>);
}

/** Mock RPC returning per-method view results; records every call. */
function rpcMock(views: Record<string, unknown>, calls: string[] = []) {
  return async (_i: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string; params?: { method_name?: string; args_base64?: string; request_type?: string };
    };
    if (body.method === "send_tx") {
      calls.push("send_tx");
      return jsonRes({ result: {
        transaction: { hash: "tx-ruling-1" },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
      } });
    }
    if (body.method === "block") {
      return jsonRes({ result: { header: { hash: b58encode(new Uint8Array(32).fill(1)) } } });
    }
    if (body.method === "query" && body.params?.request_type === "view_access_key") {
      return jsonRes({ result: { nonce: 0, permission: "FullAccess" } });
    }
    const name = body.params?.method_name ?? "";
    calls.push(`view:${name}`);
    const res = views[name];
    if (res === undefined) return jsonRes({ result: { result: [], error: "method not found" } });
    return jsonRes({ result: { result: [...new TextEncoder().encode(JSON.stringify(res))] } });
  };
}

const OPEN_MARKET = { marketId: "7", status: "open", locked: "1000000000000000000000000",
  specHash: "sha256:abc", disputeBondYocto: null };

describe("D4 disputePlan", () => {
  it("returns the bonded dispute call — the disputer's deposit, never ours", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", rpcMock({
      getMarket: OPEN_MARKET, getDisputes: [],
    }, calls));
    const plan = await disputePlan(env(), "7", "3", "bafyEvidence") as Record<string, unknown>;
    expect(plan.error).toBeUndefined();
    const call = plan.call as { method: string; args: Record<string, unknown>; deposit_yocto: string };
    expect(call.method).toBe("dispute");
    expect(call.args).toMatchObject({ marketId: "7", claimId: "3", evidenceCid: "bafyEvidence" });
    expect(call.deposit_yocto).toBe("100000000000000000000000"); // default 0.1 NEAR
    // read-only: building a plan never sends a tx
    expect(calls.filter((c) => c === "send_tx")).toEqual([]);
  });

  it("refuses non-open markets and markets already frozen", async () => {
    vi.stubGlobal("fetch", rpcMock({
      getMarket: { ...OPEN_MARKET, status: "paid" }, getDisputes: [],
    }));
    expect((await disputePlan(env(), "7", "3") as { error: string }).error).toMatch(/paid/);
    vi.stubGlobal("fetch", rpcMock({
      getMarket: OPEN_MARKET,
      getDisputes: [{ status: "open", claimId: "3" }],
    }));
    expect((await disputePlan(env(), "7", "3") as { error: string }).error).toMatch(/already freezes/);
  });
});

describe("D4 evidence bundle", () => {
  it("carries market + claim + verdict tally in Kleros-evidence shape", async () => {
    vi.stubGlobal("fetch", rpcMock({
      getMarket: OPEN_MARKET,
      getClaims: { claims: [{ claimId: "3", claimant: "w.testnet", status: "pending" }] },
      getVerdicts: { votes: { aaaa: { claimId: "3", verdict: "accept" } }, acceptVotes: 1 },
    }));
    const b = await evidenceBundle(env(), "7", "3") as Record<string, unknown>;
    expect((b["@context"] as string)).toMatch(/evidence-standard/i);
    expect((b.market as { marketId: string }).marketId).toBe("7");
    expect((b.claim as { claimant: string }).claimant).toBe("w.testnet");
    expect((b.verdicts as { acceptVotes: number }).acceptVotes).toBe(1);
  });
});

describe("D4 interim rulings", () => {
  it("signs resolveDispute on-chain from the contract account", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", rpcMock({}, calls));
    const r = await submitRuling(env(), "7", "3", "pay_claim") as Record<string, unknown>;
    expect(r.ruled).toBe(true);
    expect(calls).toContain("send_tx");
  });

  it("rejects invalid rulings before touching the chain", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", rpcMock({}, calls));
    expect((await submitRuling(env(), "7", "3", "whatever") as { error: string }).error)
      .toMatch(/ruling must be/);
    expect(calls).toEqual([]);
  });
});
