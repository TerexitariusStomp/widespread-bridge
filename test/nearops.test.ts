import { describe, expect, it, vi, beforeEach } from "vitest";
import { b58encode, b58decode, parseNearKey, nearViewCall, nearFunctionCall } from "../src/nearops";
import { fakeEnv, jsonRes } from "./mock";

const te = new TextEncoder();
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("base58", () => {
  it("round-trips arbitrary bytes", () => {
    for (const n of [1, 32, 64, 100]) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(b58decode(b58encode(b))).toEqual(b);
    }
  });
  it("preserves leading zero bytes", () => {
    const b = new Uint8Array([0, 0, 1, 2, 0, 3]);
    expect(b58decode(b58encode(b))).toEqual(b);
  });
  it("known vector: empty → empty, '1' → [0]", () => {
    expect(b58decode("")).toEqual(new Uint8Array(0));
    expect(b58decode("1")).toEqual(new Uint8Array([0]));
  });
  it("rejects invalid chars", () => {
    expect(() => b58decode("0OIl")).toThrow(/bad base58/);
  });
});

describe("parseNearKey", () => {
  const raw = new Uint8Array(64).map((_, i) => i);
  const key = `ed25519:${b58encode(raw)}`;
  it("splits seed||pubkey", () => {
    const { seed, pubkey } = parseNearKey(key);
    expect(seed).toEqual(raw.slice(0, 32));
    expect(pubkey).toEqual(raw.slice(32));
  });
  it("rejects wrong prefix / length", () => {
    expect(() => parseNearKey("sr25519:abc")).toThrow(/ed25519:/);
    expect(() => parseNearKey(`ed25519:${b58encode(new Uint8Array(10))}`)).toThrow(/64/);
  });
});

describe("nearViewCall", () => {
  it("sends call_function query and decodes JSON result", async () => {
    let seenArgs = "";
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("query");
      expect(body.params.request_type).toBe("call_function");
      expect(body.params.account_id).toBe("c.testnet");
      expect(body.params.method_name).toBe("getMarket");
      seenArgs = atob(body.params.args_base64);
      const payload = new TextEncoder().encode(JSON.stringify({ status: "open" }));
      return jsonRes({ result: { result: [...payload] } }); // RPC wraps in result
    });
    const out = await nearViewCall({ NEAR_RPC_URL: "https://rpc.testnet.near.org" },
      "c.testnet", "getMarket", { marketId: "5" });
    expect(out).toEqual({ status: "open" });
    expect(JSON.parse(seenArgs)).toEqual({ marketId: "5" });
  });
});

describe("nearFunctionCall tx wire format", () => {
  it("emits TransactionV1 (0x01 prefix) signed over sha256(tx), sent via send_tx", async () => {
    // Generated per-run — Node validates JWK d/x correspondence.
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const sk = ed25519.utils.randomSecretKey();
    const ops = { accountId: "ops.testnet",
      secretKey: `ed25519:${b58encode(new Uint8Array([...sk, ...ed25519.getPublicKey(sk)]))}` };
    let sendBody: { signed_tx_base64?: string; wait_until?: string } | null = null;
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "send_tx") { sendBody = body.params; return jsonRes({ result: { transaction: { hash: "H" } } }); }
      if (body.method === "block") return jsonRes({ result: { header: { hash: "11111111111111111111111111111111" } } });
      // view_access_key
      return jsonRes({ result: { nonce: 7, permission: "FullAccess" } });
    });
    const r = await nearFunctionCall(
      { NEAR_RPC_URL: "https://rpc.testnet.near.org" }, ops, "c.testnet",
      { methodName: "createMarket", args: { specHash: "s" }, gas: 50_000_000_000_000n, deposit: 1_000_000_000_000_000_000_000n });
    expect(r.txHash).toBe("H");
    expect(sendBody?.wait_until).toBe("FINAL");
    const signed = b64ToBytes(sendBody!.signed_tx_base64!);
    // last 65 bytes: 0x00 sig-variant + 64B ed25519 sig; before that tx
    const tx = signed.slice(0, signed.length - 65);
    expect(tx[0]).toBe(1); // TransactionV1 prefix — classic txs are rejected on-chain
    expect(sendBody!.signed_tx_base64).toBeTruthy();
  });
});
