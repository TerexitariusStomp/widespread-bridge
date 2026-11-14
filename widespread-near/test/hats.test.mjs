// hats.test.mjs — IntentionalHats contract tests against the COMPILED
// wasm in a real nearcore sandbox (near-workspaces). No stub runtime:
// the contract executes exactly as it does on testnet.
//
// Prereq: contracts/hats/build/contract.wasm — rebuild with
//   cd contracts/hats && node ../../node_modules/near-sdk-js/lib/cli/cli.js build contract.src.js build/contract.wasm

import test from "node:test";
import assert from "node:assert/strict";
import nearWorkspaces from "near-workspaces";
const { Worker } = nearWorkspaces;

const WASM = new URL("../contracts/hats/build/contract.wasm", import.meta.url).pathname;
const GAS = "300000000000000";

let worker, root, contract, alice, bob, carol;
const call = (acct, method, args = {}, opt = {}) =>
  acct.call(contract, method, args, { gas: GAS, ...opt });
const view = (method, args = {}) => contract.view(method, args);
const reverts = (p, re) => assert.rejects(p, re ? new RegExp(re) : undefined);

test.before(async () => {
  worker = await Worker.init();
  root = worker.rootAccount;
  contract = await root.devDeploy(WASM);
  alice = await root.createSubAccount("alice");
  bob = await root.createSubAccount("bob");
  carol = await root.createSubAccount("carol");
  await call(alice, "createOrg", { name: "acme" }); // org "1", top hat "1"
});
test.after(() => worker.tearDown());

const mkhat = (name, permissions) =>
  call(alice, "createHat", { orgId: "1", parentHatId: "1", name, permissions });

test("createOrg mints org + top hat worn by creator with * scope", async () => {
  const hat = await view("getHat", { hatId: "1" });
  assert.equal(hat.wearer, "alice.test.near");
  assert.deepEqual(hat.permissions, ["*"]);
  assert.equal(hat.parentHatId, null);
  assert.equal((await view("getOrg", { orgId: "1" })).name, "acme");
});

test("createHat: parent wearer mints child; stranger cannot", async () => {
  await reverts(call(bob, "createHat",
    { orgId: "1", parentHatId: "1", name: "x", permissions: ["a"] }), "authority");
  const id = await mkhat("worker", ["market:claim"]);
  assert.equal((await view("getHat", { hatId: id })).adminHatId, "1");
});

test("assignHat grants to wearer; non-wearer cannot set stance", async () => {
  const id = await mkhat("claimable", ["market:claim"]);
  await call(alice, "assignHat", { hatId: id, wearer: "bob.test.near" });
  assert.equal((await view("getHat", { hatId: id })).wearer, "bob.test.near");
  await reverts(call(carol, "setStance", { hatId: id, prefs: {} }), "wearer");
});

test("hasScope enforces declared scope", async () => {
  const id = await mkhat("scoped", ["market:claim"]);
  await call(alice, "assignHat", { hatId: id, wearer: "bob.test.near" });
  assert.equal(await view("hasScope", { hatId: id, scope: "market:claim" }), true);
  assert.equal(await view("hasScope", { hatId: id, scope: "admin:nuke" }), false);
});

test("revokeHat revokes; revoked hat rejects further use", async () => {
  const id = await mkhat("temp", ["x"]);
  await call(alice, "assignHat", { hatId: id, wearer: "carol.test.near" });
  await call(alice, "revokeHat", { hatId: id, reason: "misuse" });
  assert.equal((await view("getHat", { hatId: id })).status, "revoked");
  await reverts(call(carol, "setStance", { hatId: id, prefs: {} }), "revoked");
});

test("setForeign is wearer-only; requestForeignSig enforces sign:<chain> scope", async () => {
  const id = await mkhat("solver", ["sign:solana"]);
  await call(alice, "assignHat", { hatId: id, wearer: "bob.test.near" });
  await reverts(call(carol, "setForeign",
    { hatId: id, chain: "solana", path: "m/44'" }), "only the wearer");
  await call(bob, "setForeign",
    { hatId: id, chain: "solana", path: "m/44'/501'", keyType: "ed25519" });
  const sigId = await call(bob, "requestForeignSig", { hatId: id, payload: [1, 2, 3] });
  assert.equal(typeof sigId, "string");
});

test("requestForeignSig rejects missing scope", async () => {
  const id = await mkhat("noob", ["market:claim"]);
  await call(alice, "assignHat", { hatId: id, wearer: "bob.test.near" });
  await call(bob, "setForeign", { hatId: id, chain: "solana", path: "p" });
  await reverts(call(bob, "requestForeignSig", { hatId: id, payload: [9] }),
    "lacks scope");
});

test("assignHat moves wearer; old wearer loses access", async () => {
  const id = await mkhat("hand", ["y"]);
  await call(alice, "assignHat", { hatId: id, wearer: "bob.test.near" });
  await call(alice, "assignHat", { hatId: id, wearer: "carol.test.near" });
  assert.equal((await view("getHat", { hatId: id })).wearer, "carol.test.near");
  await reverts(call(bob, "setStance", { hatId: id, prefs: {} }), "wearer");
});
