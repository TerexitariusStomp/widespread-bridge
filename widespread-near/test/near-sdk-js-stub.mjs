// near-sdk-js stub — just enough surface for contract.src.js to load and
// run under plain Node. `near` is a shared mutable context on globalThis
// so the harness and the bundled contract see the same object.

import { createHash } from "node:crypto";

export const near = (globalThis.__NEAR_CTX ??= {});

// Host-function stand-ins: real sha256 so commit-reveal tests exercise the
// actual digest check, plus the utils.encode the contract hashes through.
near.sha256 ??= (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
export const encode = (s) => new TextEncoder().encode(s);

// Default no-op surfaces used by the hats contract (MPC sig requests,
// promise chaining, logging). Tests override per-call via setNear or by
// setting near.__promiseResults / near.__calls.
near.log ??= () => {};
near.currentAccountId ??= () => "contract.testnet";
near.promiseBatchActionFunctionCall ??= () => {};
near.promiseThen ??= () => 0;
near.promiseResult ??= () => (near.__promiseResults ?? []).shift() ?? null;
near.__calls ??= [];
const _fnCall = near.promiseBatchActionFunctionCall;
near.promiseBatchActionFunctionCall = (...a) => { near.__calls.push({ fn: a }); return _fnCall(...a); };

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// Decorators are metadata-only for our purposes — pass through.
// Storage-backed collection shim for tests — near-sdk-js LookupMap
// persists each entry under (keyPrefix + key) in contract storage; the
// harness doesn't model storage, so a plain Map per instance does.
export class LookupMap {
  constructor(keyPrefix) {
    this.keyPrefix = keyPrefix;
    this._m = new Map();
  }
  get(key) { return this._m.get(key) ?? null; }
  set(key, value) { this._m.set(key, value); }
  remove(key) { this._m.delete(key); }
  containsKey(key) { return this._m.has(key); }
}

export function NearBindgen() { return (cls) => cls; }
export function call() { return (_t, _k, d) => d; }
export function view() { return (_t, _k, d) => d; }
