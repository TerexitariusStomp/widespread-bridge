// nearops.ts — minimal NEAR transaction signer for the ops account.
//
// The bridge can't custody a full near-api-js stack in a Worker, so this
// implements exactly what createMarket needs: ed25519 key handling,
// access-key nonce + block hash lookups, borsh serialization of a
// FunctionCall action, and broadcast_tx_commit. ~150 LOC, zero deps.
//
// Key format: NEAR secret keys are `ed25519:<base58>` where the decoded
// 64 bytes = 32-byte seed || 32-byte public key.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s: string): Uint8Array {
  if (s === "") return new Uint8Array(0);
  // Leading '1's encode zero bytes — count them, decode the rest as a
  // magnitude, then prepend. (The old in-place version double-counted.)
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const rest = s.slice(zeros);
  const bytes = [0];
  for (const ch of rest) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error(`bad base58 char ${ch}`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const mag = rest ? new Uint8Array(bytes.reverse()) : new Uint8Array(0);
  const out = new Uint8Array(zeros + mag.length);
  out.set(mag, zeros);
  return out;
}

export function b58encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function u32(n: number): Uint8Array { return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); }
function u64(n: bigint): Uint8Array { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn); return b; }
function u128(n: bigint): Uint8Array { const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn); return b; }
function str(s: string): Uint8Array { const b = new TextEncoder().encode(s); return concat(u32(b.length), b); }
function vec(b: Uint8Array): Uint8Array { return concat(u32(b.length), b); }
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface NearOpsKey {
  accountId: string;   // derived: ops account id comes from env/secret pair
  secretKey: string;   // ed25519:<b58>
}

export function parseNearKey(secretKey: string): { seed: Uint8Array; pubkey: Uint8Array } {
  const m = secretKey.match(/^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/);
  if (!m) throw new Error("NEAR_OPS_SECRET_KEY must be ed25519:<base58>");
  const raw = b58decode(m[1]);
  if (raw.length !== 64) throw new Error(`near key decoded to ${raw.length}B, expected 64`);
  return { seed: raw.slice(0, 32), pubkey: raw.slice(32) };
}

// Account-id determines the network: a *.testnet account only exists on
// testnet, so query it there regardless of the configured default RPC
// (the market contract moved to mainnet; futarchy/hats are still testnet).
const TESTNET_RPC = "https://rpc.testnet.near.org";
const rpc = (env: { NEAR_RPC_URL?: string }, accountId?: string) =>
  accountId?.endsWith(".testnet") ? TESTNET_RPC
    : env.NEAR_RPC_URL ?? TESTNET_RPC;

async function rpcCall<T>(env: { NEAR_RPC_URL?: string }, method: string, params: unknown, accountId?: string): Promise<T> {
  const res = await fetch(rpc(env, accountId), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ops", method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await res.json()) as { result?: T; error?: { message?: string; data?: string; cause?: { info?: { error_message?: string } } } };
  if (j.error) {
    const e = j.error as Record<string, unknown>;
    const causeInfo = e.cause && typeof e.cause === "object"
      ? (e.cause as { info?: unknown }).info ?? e.cause
      : undefined;
    const detail = causeInfo ?? (typeof e.data === "string" ? e.data : e.data)
      ?? e.message;
    const rendered = typeof detail === "string" ? detail : JSON.stringify(detail ?? e);
    throw new Error(`near rpc ${method}: ${rendered === "{}" ? JSON.stringify(e) : rendered}`);
  }
  return j.result as T;
}

async function accessKeyNonce(env: { NEAR_RPC_URL?: string }, accountId: string, pubkeyB58: string): Promise<bigint> {
  // view_access_key returns {nonce, permission} at top level for the
  // queried key (single-key query — no array wrapper).
  const r = await rpcCall<{ nonce?: number; permission?: string }>(
    env, "query", {
      request_type: "view_access_key", finality: "final",
      account_id: accountId, public_key: `ed25519:${pubkeyB58}`,
    }, accountId);
  if (r.permission !== "FullAccess" || r.nonce == null)
    throw new Error(`no full-access key on ${accountId} (got ${r.permission ?? "none"})`);
  return BigInt(r.nonce) + 1n;
}

async function latestBlockHash(env: { NEAR_RPC_URL?: string }, accountId?: string): Promise<Uint8Array> {
  const b = await rpcCall<{ header?: { hash?: string } }>(env, "block", { finality: "final" }, accountId);
  const h = b.header?.hash;
  if (!h) throw new Error("no block hash");
  return b58decode(h);
}

function b64url(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function edSign(seed: Uint8Array, pubkey: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  // Workers WebCrypto only accepts Ed25519 private keys as JWK (OKP),
  // not raw bytes.
  const jwk = {
    kty: "OKP", crv: "Ed25519",
    d: b64url(seed), x: b64url(pubkey),
    key_ops: ["sign"], ext: false,
  };
  const key = await crypto.subtle.importKey(
    "jwk", jwk as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key, msg as BufferSource));
}

export interface FunctionCallSpec {
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;       // yoctoGas
  deposit: bigint;   // yoctoNEAR
}

/** Sign + broadcast a FunctionCall tx from the ops account. Returns the
 * tx hash + receipts outcome status. */
export async function nearFunctionCall(
  env: { NEAR_RPC_URL?: string },
  ops: NearOpsKey,
  contractId: string,
  call: FunctionCallSpec,
): Promise<{ txHash: string; status: unknown }> {
  const { seed, pubkey } = parseNearKey(ops.secretKey);
  const pubkeyB58 = b58encode(pubkey);
  const nonce = await accessKeyNonce(env, ops.accountId, pubkeyB58);
  const blockHash = await latestBlockHash(env, ops.accountId);

  // Transaction borsh
  const argsBytes = new TextEncoder().encode(JSON.stringify(call.args));
  const action = concat(
    new Uint8Array([2]),                    // Action::FunctionCall
    str(call.methodName),
    vec(argsBytes),
    u64(call.gas),
    u128(call.deposit),
  );
  // TransactionV1 (nearcore's current wire format — classic transactions
  // are rejected with "invalid transaction version tag"): version=0x01,
  // nonce as TransactionNonce enum {nonce:u64} (variant 0), nonceMode
  // enum monotonic (variant 0) after actions.
  const tx = concat(
    new Uint8Array([1]),                    // Transaction::V1 prefix
    str(ops.accountId),                     // signer_id
    new Uint8Array([0]), pubkey,            // PublicKey::ED25519 + key
    new Uint8Array([0]), u64(nonce),        // TransactionNonce::Nonce{nonce}
    str(contractId),                        // receiver_id
    blockHash,
    u32(1), action,                         // actions vec
    new Uint8Array([0]),                    // NonceMode::Monotonic
  );
  // NEAR signs SHA-256(serialized transaction), not the raw bytes —
  // verified byte-identical against near-api-js encode().
  const txHash = new Uint8Array(await crypto.subtle.digest("SHA-256", tx as BufferSource));
  const sig = await edSign(seed, pubkey, txHash);
  const signedTx = concat(tx, new Uint8Array([0]), sig); // Signature::ED25519 + 64B
  let bin = "";
  for (let i = 0; i < signedTx.length; i += 8192) {
    bin += String.fromCharCode(...signedTx.subarray(i, i + 8192));
  }
  const b64 = btoa(bin);

  // Modern RPC: send_tx takes {signed_tx_base64, wait_until} — the legacy
  // broadcast_tx_commit(base58) endpoint is deprecated and rejects valid
  // TransactionV1 payloads.
  const result = await rpcCall<{
    transaction?: { hash?: string };
    receipts_outcome?: { outcome?: { status?: unknown } }[];
    status?: unknown;
  }>(env, "send_tx", { signed_tx_base64: b64, wait_until: "FINAL" }, ops.accountId);
  const status = result.receipts_outcome?.map((r) => r?.outcome?.status ?? r) ?? result.status ?? result;
  return { txHash: result.transaction?.hash ?? "", status };
}

/** Read-only contract call — returns the JSON-parsed result bytes. */
export async function nearViewCall(
  env: { NEAR_RPC_URL?: string },
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const r = await rpcCall<{ result?: number[] }>(env, "query", {
    request_type: "call_function", finality: "final",
    account_id: contractId, method_name: methodName,
    args_base64: btoa(bin),
  }, contractId);
  const out = new Uint8Array(r.result ?? []);
  return JSON.parse(new TextDecoder().decode(out));
}

/** NEAR price in USD from the Intents token list (wNEAR on near chain). */
export async function nearPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://1click.chaindefuser.com/v0/tokens", {
      signal: AbortSignal.timeout(8000),
    });
    interface Tok { blockchain?: string; symbol?: string; price?: number }
    const data = (await res.json()) as Tok[] | { tokens?: Tok[] };
    const list: Tok[] = Array.isArray(data) ? data : data.tokens ?? [];
    const wnear = list.find((t: Tok) => t.blockchain === "near" && t.symbol === "wNEAR");
    return wnear?.price ?? null;
  } catch { return null; }
}
