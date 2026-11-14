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
const o4x = JSON.parse(readFileSync("/tmp/o4-x25519.json"));
const o4xPub = o4x.publicKey;
const funder = cryptoBoxKeyPair();
const funderPub = toHex(funder.publicKey);
writeFileSync("/tmp/e2e-funder.json", JSON.stringify({ publicKey: funderPub, secretKey: toHex(funder.privateKey) }));
const opsA = new Account(ops.accountId, RPC, new KeyPairSigner(KeyPair.fromString(ops.secretKey)));

const MARKET = "24";
const SPEC = `e2e collective spec`;      // spec_hash recompute not needed — decl already bound
const DELIV = "We carry your secrets in sealed boxes — even we never look inside.";
const delivBytes = new TextEncoder().encode(DELIV);
const delivSha = (await sha256(delivBytes)).slice(7);

// the on-chain specHash must match the declared spec_hash — fetch it
const m = await (async () => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "e", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: CONTRACT,
        method_name: "getMarket", args_base64: Buffer.from(JSON.stringify({ marketId: MARKET })).toString("base64") } }) }).then((x) => x.json());
  return JSON.parse(Buffer.from(r.result.result).toString());
})();
console.log("market specHash:", m.specHash?.slice(0, 30));

const attest = await fetch(`${B}/api/claims`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    marketId: MARKET,
    forgeRef: `sealed://${delivSha}`,
    specHash: m.specHash,
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
  }) }).then((r) => r.json().catch(() => ({ error: "non-json" })));
console.log("attest:", JSON.stringify(attest).slice(0, 300));
if (!attest.ok) process.exit(1);
const claimId = await opsA.callFunction({ contractId: CONTRACT, methodName: "shipClaim",
  args: attest.shipClaimArgs, gas: GAS, deposit: 0n });
console.log("claimId:", claimId);
writeFileSync("/tmp/e2e-state.json", JSON.stringify({ marketId: MARKET, claimId: String(claimId) }));
