// e2e collective market: bridge declares a spec_sealed market with
// oracle4 as the sole adjudicator → ops creates the on-chain market →
// worker ships a claim sealed to the funder + juror → the runner scans,
// decrypts, judges, votes, releases. Full path, zero bridge plaintext.
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { cryptoBoxSeal, cryptoBoxKeyPair } from "@serenity-kit/noble-sodium";
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";

const B = "https://widespread-bridge.widespread.workers.dev";
const RPC = "https://rpc.testnet.fastnear.com";
const CONTRACT = "wide-mkt-11561.testnet";
const GAS = BigInt("100000000000000");
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const seal = (bytes, pubHex) =>
  btoa(String.fromCharCode(...cryptoBoxSeal({ message: bytes, publicKey: fromHex(pubHex) })));
const sha256 = async (b) => "sha256:" + toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));

const ops = JSON.parse(readFileSync("/home/shredder/.widespread-near.json"));
const o4c = JSON.parse(readFileSync("/tmp/o2.json"));
const opsA = new Account(ops.accountId, RPC, new KeyPairSigner(KeyPair.fromString(ops.secretKey)));
const call = (a, method, args, dep = 0n) =>
  a.callFunction({ contractId: CONTRACT, methodName: method, args, gas: GAS, deposit: dep });
const view = async (m, args = {}) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "e", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: CONTRACT,
        method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) }).then((x) => x.json());
  return r.result?.result ? JSON.parse(Buffer.from(r.result.result).toString()) : null;
};

// oracle4's oracle seat id (registered earlier) + its x25519 juror key
const O4_ORACLE_PUBKEY = "44178a636956643032c6d8a4673878a7b0a237f56dde59673b9b18dfc71df7e6";
const o4x = cryptoBoxKeyPair();
const o4xPub = toHex(o4x.publicKey);
const funder = cryptoBoxKeyPair();
const funderPub = toHex(funder.publicKey);
writeFileSync("/tmp/o4-x25519.json", JSON.stringify({ publicKey: o4xPub, secretKey: toHex(o4x.privateKey) }));

const SPEC = `e2e collective ${Date.now()}: write a 30-word tagline for an encrypted courier service`;
const DELIV = "We carry your secrets in sealed boxes — even we never look inside.";
const specBytes = new TextEncoder().encode(SPEC);
const delivBytes = new TextEncoder().encode(DELIV);
const specHash = await sha256(specBytes);

// 1. declare the collective market
const decl = await fetch(`${B}/api/bounty/declare`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    spec_sealed: true, spec_hash: specHash,
    adjudicator_x25519_pubkeys: [o4xPub],
    spec_sealed_adjudicators_b64: { [o4xPub]: seal(specBytes, o4xPub) },
    funder_x25519_pubkey: funderPub,
    domain: "writing", amount: "5",
    capacity: { dims: ["C_k"], evidence_plan: { measure: "deliverable verified", horizon_days: 7 } },
  }) }).then((r) => r.json());
if (!decl.hash) { console.log("declare failed:", decl); process.exit(1); }
console.log("declared:", decl.hash);

// 2. ops creates the on-chain market — collective stub, quorum=1, jury=oracle4
const marketId = String(Date.now() % 1000000);
const specStub = `[confidential:writing] decl=${decl.hash}`;
const cm = await call(opsA, "createMarket", {
  marketId, specHash, spec: specStub,
  deadline: String(BigInt(Date.now()) * 1000000n + 7n * 24n * 3600n * 1000000000n),
  acceptanceRule: "sealed deliverable satisfies spec",
  payToHat: null, claimTtlNs: null, acceptanceHash: null,
  platformBps: 0, platformTo: null,
  oracleQuorumM: 1, oracleAllowlist: [O4_ORACLE_PUBKEY],
}, BigInt("1000000000000000000000000"));
console.log("market:", marketId, "created");

// 3. worker ships the claim — sealed to funder + the juror (NOT bridge)
const delivSha = (await sha256(delivBytes)).slice(7);
const claimBody = {
  marketId,
  forgeRef: `sealed://${delivSha}`,
  specHash,
  claimant: "oracle4.wide-mkt-11561.testnet",
  actor: "did:key:zE2eWorker",
  commits: [],
  evidence: {
    artifact_sealed: {
      ciphertext_funder_b64: seal(delivBytes, funderPub),
      ciphertext_adjudicators_b64: { [o4xPub]: seal(delivBytes, o4xPub) },
      artifact_sha256: `sha256:${delivSha}`,
    },
  },
};
const attest = await fetch(`${B}/api/claims`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(claimBody) }).then((r) => r.json());
console.log("attest:", attest.ok, attest.attested, attest.failures ?? "");
if (!attest.ok) process.exit(1);
const claimId = await call(opsA, "shipClaim", attest.shipClaimArgs);
console.log("claim shipped:", claimId);
writeFileSync("/tmp/e2e-state.json", JSON.stringify({
  declHash: decl.hash, marketId, claimId, o4OraclePubkey: O4_ORACLE_PUBKEY, o4x,
  specHash, account: o4c.accountId, secretKey: o4c.secretKey }));
console.log("state saved → run the runner");
