// contract.src.js — Intentional Hats: cross-chain-native role/permission
// protocol for agentic commerce (near-sdk-js 2.x, same pattern as
// contracts/market). Source of truth — `contract.js` in this dir is the
// rollup bundle produced by `cli.js build contract.src.js`.
//
// A hat is an on-chain role: org → hat tree with admin + accountability
// relations, capability-scope permissions, a chain-signatures derivation
// path (the hat controls foreign-chain addresses via v1.signer MPC), and a
// stance profile (declared prefs + vetoes; earned stance is computed
// off-chain from verdict records). Settlement legs (Intents payouts, foreign
// tx broadcast) execute via the bridge — contracts record intent, bridge
// acts, contract stores receipts.
//
// Simocracy-aligned: constitutionRef/identityRef are opaque pointers
// (ATProto sim URI, ERC-8004 agentId, any DID) — referenced, never embedded.
// Every mutation emits a structured log event for collaborator indexing.

import { NearBindgen, near, call, view, assert } from "near-sdk-js";

const ACTIVE = "active";
const REVOKED = "revoked";
const SIGNER = "v1.signer-prod.testnet"; // chain-signatures MPC (testnet)
// NEAR bounds sum of child-call gas by the parent receipt's gas_limit (≤300 Tgas),
// so SIGN+PAY must fit in one tx. 200 Tgas proved sufficient for `sign` on testnet.
const SIGN_GAS = 200_000_000_000_000n; // 200 Tgas
const PAY_GAS = 80_000_000_000_000n;  // 80 Tgas — callback reads promiseResult + writes state
const SIGN_DEPOSIT = 300_000_000_000_000n; // 0.0003 NEAR — MPC request fee

const evt = (type, data) =>
  near.log(JSON.stringify({ event: type, ...data }));

@NearBindgen({})
export class IntentionalHats {
  constructor() {
    this.orgs = {};      // orgId -> { name, creator, createdAt }
    this.hats = {};      // hatId -> hat record
    this.payouts = {};   // payoutId -> payout record
    this.sigs = {};      // sigId -> signature request record
    this.nextOrg = 1;
    this.nextHat = 1;
    this.nextPayout = 1;
    this.nextSig = 1;
  }

  // ---------- org + hat tree ----------

  @call({})
  createOrg({ name }) {
    const creator = near.predecessorAccountId();
    const orgId = String(this.nextOrg++);
    this.orgs[orgId] = { orgId, name, creator, createdAt: near.blockTimestamp().toString() };
    // Top hat = org superadmin, worn by creator.
    const hatId = String(this.nextHat++);
    this.hats[hatId] = {
      hatId, orgId, name: "top", parentHatId: null, adminHatId: null,
      accountableTo: null, wearer: creator, permissions: ["*"],
      status: ACTIVE, foreign: null, identityRef: null, constitutionRef: null,
      stance: { prefs: {}, vetoes: [] }, createdAt: near.blockTimestamp().toString(),
    };
    evt("hat.minted", { hatId, orgId, name: "top", wearer: creator });
    evt("org.created", { orgId, name, creator });
    return { orgId, topHatId: hatId };
  }

  @call({})
  createHat({ orgId, parentHatId, name, permissions, identityRef, constitutionRef }) {
    const caller = near.predecessorAccountId();
    assert(this.orgs[orgId], "unknown org");
    const parent = this.hats[parentHatId];
    assert(parent && parent.orgId === orgId, "parent hat not in org");
    assert(parent.status === ACTIVE, "parent hat revoked");
    // Only the parent hat's wearer (or an admin hat up the tree) may mint children.
    this._requireWearerOrAdmin(parent, caller);
    const hatId = String(this.nextHat++);
    this.hats[hatId] = {
      hatId, orgId, name, parentHatId,
      adminHatId: parentHatId,          // parent administers this hat
      accountableTo: parentHatId,       // parent can revoke this hat
      wearer: caller, permissions: permissions || [],
      status: ACTIVE, foreign: null,
      identityRef: identityRef || null, constitutionRef: constitutionRef || null,
      stance: { prefs: {}, vetoes: [] }, createdAt: near.blockTimestamp().toString(),
    };
    evt("hat.minted", { hatId, orgId, name, parentHatId, wearer: caller });
    return hatId;
  }

  @call({})
  assignHat({ hatId, wearer }) {
    const caller = near.predecessorAccountId();
    const hat = this._activeHat(hatId);
    this._requireWearerOrAdmin(hat, caller);
    hat.wearer = wearer;
    evt("hat.assigned", { hatId, wearer });
    return true;
  }

  @call({})
  revokeHat({ hatId, reason }) {
    const caller = near.predecessorAccountId();
    const hat = this.hats[hatId];
    assert(hat, "unknown hat");
    // Accountability: the accountableTo hat's wearer (or org top) revokes.
    const boss = hat.accountableTo ? this.hats[hat.accountableTo] : null;
    const top = this._topHat(hat.orgId);
    const allowed =
      (boss && boss.wearer === caller) || top.wearer === caller;
    assert(allowed, "caller cannot revoke this hat");
    hat.status = REVOKED;
    evt("hat.revoked", { hatId, by: caller, reason: reason || "" });
    return true;
  }

  // ---------- permissions ----------

  @call({})
  setPermissions({ hatId, permissions }) {
    const caller = near.predecessorAccountId();
    const hat = this._activeHat(hatId);
    this._requireWearerOrAdmin(hat, caller);
    hat.permissions = permissions || [];
    evt("hat.permissions.set", { hatId, permissions: hat.permissions });
    return true;
  }

  // ---------- foreign-chain identity (chain signatures) ----------

  @call({})
  setForeign({ hatId, chain, path, keyType }) {
    const caller = near.predecessorAccountId();
    const hat = this._activeHat(hatId);
    assert(hat.wearer === caller, "only the wearer sets foreign identity");
    hat.foreign = { chain, path, keyType: keyType || "ed25519" };
    evt("hat.foreign.set", { hatId, chain, path });
    return true;
  }

  // Request an MPC signature for a foreign-chain payload. The hat must hold
  // `sign:<chain>` scope (or `*`). Result lands via sigCallback.
  @call({})
  requestForeignSig({ hatId, payload, path, keyType }) {
    const caller = near.predecessorAccountId();
    const hat = this._activeHat(hatId);
    assert(hat.wearer === caller, "only the wearer requests signatures");
    const chain = hat.foreign ? hat.foreign.chain : "unknown";
    this._requireScope(hat, `sign:${chain}`);
    const sigId = String(this.nextSig++);
    this.sigs[sigId] = {
      sigId, hatId, caller, payload: Array.from(payload || []),
      path: path || (hat.foreign && hat.foreign.path) || "",
      keyType: keyType || (hat.foreign && hat.foreign.keyType) || "ed25519",
      status: "requested", createdAt: near.blockTimestamp().toString(),
    };
    evt("hat.sig.requested", { sigId, hatId, chain });
    // v1.signer `sign` wire format (verified against chainsig.js + near/mpc):
    // {request:{payload_v2:{Eddsa|Ecdsa:<hex>}, path, domain_id}} + 0.0003N fee.
    const isEddsa = /ed25519|eddsa/i.test(this.sigs[sigId].keyType);
    const hex = Array.from(this.sigs[sigId].payload)
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const args = JSON.stringify({
      request: {
        payload_v2: { [isEddsa ? "Eddsa" : "Ecdsa"]: hex },
        path: this.sigs[sigId].path,
        domain_id: isEddsa ? 1 : 0,
      },
    });
    const idx = near.promiseBatchCreate(SIGNER);
    near.promiseBatchActionFunctionCall(
      idx, "sign", args, SIGN_DEPOSIT, SIGN_GAS
    );
    near.promiseThen(
      idx, near.currentAccountId(), "sigCallback",
      JSON.stringify({ sigId }), 0n, PAY_GAS
    );
    return sigId;
  }

  @call({})
  sigCallback({ sigId }) {
    const sig = this.sigs[sigId];
    assert(sig, "unknown sig request");
    // The MPC result arrives via promiseResult — not as callback args.
    try {
      sig.status = "signed";
      sig.result = near.promiseResult(0);
    } catch (e) {
      sig.status = "failed";
      sig.error = String(e);
    }
    evt("hat.sig.completed", { sigId, hatId: sig.hatId, status: sig.status });
  }

  // ---------- stance (Simocracy-aligned personality) ----------

  @call({})
  setStance({ hatId, prefs, vetoes, constitutionRef }) {
    const caller = near.predecessorAccountId();
    const hat = this._activeHat(hatId);
    assert(hat.wearer === caller, "only the wearer sets stance");
    hat.stance = {
      prefs: prefs || {},
      vetoes: vetoes || [],
      constitutionRef: constitutionRef || hat.constitutionRef,
    };
    evt("hat.stance.set", { hatId, prefs: hat.stance.prefs, vetoes: hat.stance.vetoes });
    return true;
  }

  // ---------- payouts (Intents leg — bridge executes, contract receipts) ----------

  @call({})
  requestPayout({ hatId, assetIn, assetOut, destChain, recipient }) {
    const caller = near.predecessorAccountId();
    const hat = this._activeHat(hatId);
    // Payout authority: hat's `treasury:pay` scope, or org top hat.
    const top = this._topHat(hat.orgId);
    if (!(top.wearer === caller && top.permissions.includes("*"))) {
      this._requireScope(hat, "treasury:pay");
      assert(hat.wearer === caller, "caller cannot spend this hat's funds");
    }
    const payoutId = String(this.nextPayout++);
    this.payouts[payoutId] = {
      payoutId, hatId, caller, assetIn, assetOut, destChain, recipient,
      status: "requested", createdAt: near.blockTimestamp().toString(),
    };
    evt("hat.payout.requested", { payoutId, hatId, destChain, assetOut });
    return payoutId;
  }

  @call({})
  confirmPayout({ payoutId, txHash }) {
    const caller = near.predecessorAccountId();
    const p = this.payouts[payoutId];
    assert(p && p.status === "requested", "payout not pending");
    // Only the requester or org top confirms settlement receipts.
    const top = this._topHat(this.hats[p.hatId].orgId);
    assert(caller === p.caller || top.wearer === caller, "cannot confirm");
    p.status = "settled";
    p.txHash = txHash;
    evt("hat.payout.settled", { payoutId, hatId: p.hatId, txHash });
    return true;
  }

  // ---------- views ----------

  @view({})
  getOrg({ orgId }) {
    return this.orgs[orgId] || null;
  }

  @view({})
  getHat({ hatId }) {
    return this.hats[hatId] || null;
  }

  @view({})
  listHats({ orgId }) {
    return Object.values(this.hats).filter((h) => h.orgId === orgId);
  }

  @view({})
  getPayout({ payoutId }) {
    return this.payouts[payoutId] || null;
  }

  @view({})
  getSig({ sigId }) {
    return this.sigs[sigId] || null;
  }

  @view({})
  hasScope({ hatId, scope }) {
    const hat = this.hats[hatId];
    if (!hat || hat.status !== ACTIVE) return false;
    return hat.permissions.includes("*") || hat.permissions.includes(scope);
  }

  // ---------- internals ----------

  _activeHat(hatId) {
    const hat = this.hats[hatId];
    assert(hat, "unknown hat");
    assert(hat.status === ACTIVE, "hat revoked");
    return hat;
  }

  _topHat(orgId) {
    return Object.values(this.hats).find(
      (h) => h.orgId === orgId && h.parentHatId === null
    );
  }

  _requireWearerOrAdmin(hat, caller) {
    if (hat.wearer === caller) return;
    // An admin hat up the tree may act: check adminHatId chain wearers.
    let cur = hat;
    while (cur && cur.adminHatId) {
      cur = this.hats[cur.adminHatId];
      if (cur && cur.wearer === caller) return;
    }
    assert(false, "caller lacks authority over this hat");
  }

  _requireScope(hat, scope) {
    const ok =
      hat.permissions.includes("*") || hat.permissions.includes(scope);
    assert(ok, `hat lacks scope: ${scope}`);
  }
}
