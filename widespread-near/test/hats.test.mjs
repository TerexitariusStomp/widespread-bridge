// hats.test.mjs — unit tests for the IntentionalHats contract (org→hat
// tree, scoped capabilities, MPC foreign-sig requests, payout receipts).
// Same esbuild+stub harness as market.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { loadContract, setNear } from "./harness.mjs";

const SRC = new URL("../contracts/hats/contract.src.js", import.meta.url).pathname;
const { Contract, near } = await loadContract(SRC, "IntentionalHats");

function setup(account = "alice.testnet") {
  const c = new Contract();
  setNear(near, { account });
  near.__calls = [];
  near.__promiseResults = [];
  return c;
}

function org(c, account = "alice.testnet") {
  setNear(near, { account });
  return c.createOrg({ name: "acme" });
}

test("createOrg mints org + top hat worn by creator with * scope", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const hat = c.getHat({ hatId: topHatId });
  assert.equal(hat.wearer, "alice.testnet");
  assert.deepEqual(hat.permissions, ["*"]);
  assert.equal(hat.parentHatId, null);
  assert.equal(c.getOrg({ orgId }).name, "acme");
});

test("createHat: parent wearer mints child; stranger cannot", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "worker",
    permissions: ["market:claim"] });
  assert.equal(c.getHat({ hatId: child }).adminHatId, topHatId);
  assert.equal(c.getHat({ hatId: child }).accountableTo, topHatId);
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.createHat({ orgId, parentHatId: child, name: "x" }),
    /lacks authority/);
});

test("revocation is accountability-based: parent revokes child, child cannot revoke parent", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "worker",
    permissions: [] });
  // child wearer tries to revoke the top hat → denied
  setNear(near, { account: "alice.testnet" });
  // alice IS top wearer here; use a different wearer for child
  const child2 = c.createHat({ orgId, parentHatId: topHatId, name: "w2", permissions: [] });
  c.assignHat({ hatId: child2, wearer: "bob.testnet" });
  setNear(near, { account: "bob.testnet" });
  assert.throws(() => c.revokeHat({ hatId: topHatId }), /cannot revoke/);
  // top wearer revokes child
  setNear(near, { account: "alice.testnet" });
  assert.equal(c.revokeHat({ hatId: child2, reason: "misuse" }), true);
  assert.equal(c.getHat({ hatId: child2 }).status, "revoked");
  // revoked hat rejects further use
  setNear(near, { account: "bob.testnet" });
  assert.throws(() => c.setStance({ hatId: child2, prefs: {} }), /revoked/);
});

test("setForeign is wearer-only; requestForeignSig enforces sign:<chain> scope", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "solver",
    permissions: ["sign:solana"] });
  // stranger cannot set foreign identity
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.setForeign({ hatId: child, chain: "solana", path: "m/44'" }),
    /only the wearer/);
  // wearer sets it, then requests a sig — emits MPC call to v1.signer
  setNear(near, { account: "alice.testnet" });
  c.setForeign({ hatId: child, chain: "solana", path: "m/44'/501'", keyType: "ed25519" });
  const sigId = c.requestForeignSig({ hatId: child, payload: [1, 2, 3] });
  assert.equal(typeof sigId, "string");
  const call = near.__calls.at(-1);
  assert.ok(call, "MPC sign call emitted");
  const args = JSON.parse(call.fn[2]);
  assert.equal(args.request.payload_v2.Eddsa, "010203");
  assert.equal(args.request.domain_id, 1);
  assert.equal(args.request.path, "m/44'/501'");
});

test("requestForeignSig rejects missing scope", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "noob",
    permissions: ["market:claim"] });
  c.setForeign({ hatId: child, chain: "solana", path: "p" });
  assert.throws(() => c.requestForeignSig({ hatId: child, payload: [9] }),
    /lacks scope: sign:solana/);
});

test("sigCallback records signed/failed from promiseResult", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "s",
    permissions: ["*"] });
  c.setForeign({ hatId: child, chain: "near", path: "p" });
  const sigId = c.requestForeignSig({ hatId: child, payload: [7] });
  near.__promiseResults = [{ signature: "deadbeef" }];
  c.sigCallback({ sigId });
  assert.equal(c.getSig({ sigId }).status, "signed");
  // failure path: promiseResult throws → our stub returns null, so force throw
  const sigId2 = c.requestForeignSig({ hatId: child, payload: [8] });
  const orig = near.promiseResult;
  near.promiseResult = () => { throw new Error("MPC timeout"); };
  c.sigCallback({ sigId: sigId2 });
  near.promiseResult = orig;
  assert.equal(c.getSig({ sigId: sigId2 }).status, "failed");
  assert.match(c.getSig({ sigId: sigId2 }).error, /MPC timeout/);
});

test("requestPayout: treasury:pay scope or top hat required", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "treasury",
    permissions: ["treasury:pay"] });
  c.assignHat({ hatId: child, wearer: "cfo.testnet" });
  setNear(near, { account: "cfo.testnet" });
  const pid = c.requestPayout({ hatId: child, assetIn: "USDC",
    assetOut: "PYUSD", destChain: "solana", recipient: "So1ana" });
  assert.equal(c.getPayout({ payoutId: pid }).status, "requested");
  // confirm by requester
  assert.equal(c.confirmPayout({ payoutId: pid, txHash: "0xabc" }), true);
  assert.equal(c.getPayout({ payoutId: pid }).status, "settled");
  // no-scope hat cannot request
  setNear(near, { account: "alice.testnet" });
  const weak = c.createHat({ orgId, parentHatId: topHatId, name: "weak",
    permissions: ["market:claim"] });
  c.assignHat({ hatId: weak, wearer: "nobody.testnet" });
  setNear(near, { account: "nobody.testnet" });
  assert.throws(() => c.requestPayout({ hatId: weak, assetIn: "a",
    assetOut: "b", destChain: "c", recipient: "d" }), /treasury:pay/);
});

test("hasScope reflects permissions", () => {
  const c = setup();
  const { orgId, topHatId } = org(c);
  const child = c.createHat({ orgId, parentHatId: topHatId, name: "h",
    permissions: ["verify:adjudicate"] });
  assert.equal(c.hasScope({ hatId: child, scope: "verify:adjudicate" }), true);
  assert.equal(c.hasScope({ hatId: child, scope: "treasury:pay" }), false);
  assert.equal(c.hasScope({ hatId: topHatId, scope: "anything" }), true); // *
});
