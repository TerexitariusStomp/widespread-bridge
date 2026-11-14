// seed.js — seed a 3-level demo org on the deployed Intentional Hats
// contract: castle (top) → council hat → worker hat (agent) with stance,
// foreign-chain identity, and a payout request.
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";

const c = JSON.parse(readFileSync(path.join(os.homedir(), ".intentional-hats.json")));
const RPC = "https://rpc.testnet.near.org";
const account = new Account(c.accountId, RPC, new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const T = "30000000000000";

const call = (methodName, args, deposit = 0n) =>
  account.callFunction({
    contractId: c.accountId, methodName, args,
    gas: BigInt(T), deposit,
  }).then((r) => {
    if (r !== null && typeof r === "object") return r;
    if (typeof r !== "string" && !(r instanceof Uint8Array)) return r;
    const s = typeof r === "string" ? r : Buffer.from(r ?? "").toString();
    try { return JSON.parse(s); } catch { return s; }
  });

// 1) org + top hat
const org = await call("createOrg", { name: "Foreguild Demo Castle" });
console.log("org:", JSON.stringify(org));
const topHat = org.topHatId;

// 2) council hat (child of top) — governance scope
const council = await call("createHat", {
  orgId: org.orgId, parentHatId: topHat, name: "council",
  permissions: ["verify:adjudicate", "treasury:pay", "governance:vote"],
  identityRef: "did:plc:foreguild-council",
});
console.log("council hat:", council);

// 3) worker hat (child of council) — the agent's hat, narrow scopes
const worker = await call("createHat", {
  orgId: org.orgId, parentHatId: council, name: "worker-agent",
  permissions: ["market:claim", "forge:ship", "sign:solana"],
  identityRef: "erc8004:agent-demo-001",
  constitutionRef: "at://did:plc:agent-sim/app.bsky.feed.post/sim-constitution",
});
console.log("worker hat:", worker);

// 4) stance — Simocracy-aligned prefs + vetoes (self-sovereign, auditable)
await call("setStance", {
  hatId: worker,
  prefs: { "oss-infra": 1, "climate": 0.6, "security": -0.4, "surveillance": -1 },
  vetoes: ["surveillance-adjacent specs", "closed-source-only deliverables"],
});
console.log("stance set on worker hat");

// 5) foreign-chain identity — solana derivation path via chain sigs
await call("setForeign", {
  hatId: worker, chain: "solana",
  path: "solana-1", keyType: "ed25519",
});
console.log("foreign identity: solana/solana-1 (ed25519)");

// 6) payout request — intents leg (bridge executes; contract receipts)
const payout = await call("requestPayout", {
  hatId: worker, assetIn: "near", assetOut: "usdc-spl",
  destChain: "solana", recipient: "derived:solana-1",
});
console.log("payout requested:", payout);

// 7) views for the record
const view = async (method_name, args) => {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: c.accountId, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  });
  const j = await r.json();
  const res = j.result?.result ?? j.result;
  const bytes = res instanceof Array ? new Uint8Array(res) : Buffer.from(res ?? "", "base64");
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return new TextDecoder().decode(bytes); }
};
console.log("hats:", JSON.stringify(await view("listHats", { orgId: org.orgId }), null, 0).slice(0, 600));
console.log("scope check market:claim:", JSON.stringify(await view("hasScope", { hatId: worker, scope: "market:claim" })));
console.log("scope check treasury:pay (should be false):", JSON.stringify(await view("hasScope", { hatId: worker, scope: "treasury:pay" })));
