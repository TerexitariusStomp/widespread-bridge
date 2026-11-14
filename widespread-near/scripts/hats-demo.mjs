// hats-demo.mjs — the Intentional Hats agent-commerce story, live.
// Runs the full loop against production endpoints + testnet contracts:
//   org chart → foreign address → stance check → ranked opportunities
//   → scope boundary → hat-scoped claim on a payToHat market.
// Usage: node scripts/hats-demo.mjs

import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os";
import path from "path";

const BRIDGE = process.env.BRIDGE ?? "https://widespread-bridge.widespread.workers.dev";
const HATS = "intentional-hats-632291.testnet";
const MARKET = "wide-mkt-11561.testnet";
const HAT_ID = "6";          // worker-agent hat
const PAYTOHAT_MARKET = "7"; // market funded with payToHat=6

const j = async (r) => r.json();
const get = (p) => fetch(`${BRIDGE}${p}`).then(j);
const post = (p, b) => fetch(`${BRIDGE}${p}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(b ?? {}),
}).then(j);
const view = async (acct, m, a) => {
  const r = await fetch("https://rpc.testnet.near.org", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: acct, method_name: m,
        args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }),
  });
  const out = await r.json();
  return JSON.parse(Buffer.from(out.result.result).toString());
};

console.log("═══ INTENTIONAL HATS — live agent-commerce demo ═══\n");

// 1. The org: castle → council → worker-agent
const org = await get(`/api/hats?org=2`);
console.log("1. ORG CHART (org 2):");
for (const h of org.hats ?? [])
  console.log(`   hat ${h.hatId} ${h.name} [${h.status}] wearer=${h.wearer} parent=${h.parentHatId ?? "-"}`);

// 2. Foreign-chain identity: the hat controls a Solana address via MPC
const foreign = await get(`/api/hats/${HAT_ID}/foreign`);
console.log("\n2. FOREIGN ADDRESS (chain-sigs MPC):");
console.log(`   chain=${foreign.foreign.chain} path=${foreign.foreign.path}`);
console.log(`   derived=${foreign.foreign.derivedPublicKey}`);
console.log(`   → solana address: ${foreign.foreign.address}`);

// 3. Stance: would this identity support the work?
const market = await view(MARKET, "getMarket", { marketId: PAYTOHAT_MARKET });
console.log(`\n3. STANCE CHECK on market ${PAYTOHAT_MARKET}:`);
console.log(`   spec: ${market.spec}`);
const stance = await post(`/api/hats/${HAT_ID}/stance-check`, { spec: market.spec });
console.log(`   support=${stance.support} score=${stance.score?.toFixed?.(2)} reasons=[${stance.reasons}]`);
console.log(`   identity=${JSON.stringify(stance.identity)}`);

// 4. Ranked opportunities: most reward for least cost, aligned first
const opps = await get(`/api/hats/${HAT_ID}/opportunities`);
console.log("\n4. OPPORTUNITY RANKING (alignment × reward / estCost):");
for (const r of (opps.ranked ?? []).slice(0, 4))
  console.log(`   #${r.marketId} score=${r.score?.toFixed?.(2)} reward=${r.reward?.toFixed?.(3)}N cost=${r.estCost} — ${r.spec?.slice(0, 55)}`);

// 5. Scope boundary: worker hat can claim markets, NOT pay treasury
const canClaim = await view(HATS, "hasScope", { hatId: HAT_ID, scope: "market:claim" });
const canPay = await view(HATS, "hasScope", { hatId: HAT_ID, scope: "treasury:pay" });
console.log(`\n5. SCOPE ENFORCEMENT:`);
console.log(`   market:claim → ${canClaim}   treasury:pay → ${canPay}  (agent can't spend what it isn't scoped for)`);

// 6. The claim: ship work against the payToHat market on-chain
const creds = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const account = new Account(creds.accountId, "https://rpc.testnet.near.org",
  new KeyPairSigner(KeyPair.fromString(creds.secretKey)));
const existing = await view(MARKET, "getClaim", { marketId: PAYTOHAT_MARKET }).catch(() => null);
if (!existing) {
  const res = await account.callFunction({
    contractId: MARKET, methodName: "shipClaim",
    args: {
      marketId: PAYTOHAT_MARKET,
      claimHash: "sha256:" + "d3m0".padEnd(64, "0"),
      actor: HATS, commits: ["demo"],
      evidence: { hatId: HAT_ID, foreign: foreign.foreign.address,
                  note: "hat-scoped claim — payout routes to hat on release" },
    },
    gas: BigInt("30000000000000"), deposit: 0n,
  });
  console.log(`\n6. CLAIM SHIPPED on market ${PAYTOHAT_MARKET}: ${JSON.stringify(res)}`);
} else {
  console.log(`\n6. CLAIM already pending on market ${PAYTOHAT_MARKET}`);
}
const after = await view(MARKET, "getMarket", { marketId: PAYTOHAT_MARKET });
console.log(`   market.payToHat=${after.payToHat} status=${after.status} locked=${(Number(after.locked)/1e24).toFixed(3)} NEAR`);

// 7. Payout quote leg (dry — NEAR Intents 1Click, no key needed)
const quote = await post(`/api/hats/payout-quote`,
  { hatId: HAT_ID, amount: "1000000", recipient: foreign.foreign.address });
console.log(`\n7. PAYOUT QUOTE (intents, dry): ${quote.error ?? quote.status}`);

console.log("\n═══ story: agent wears hat → stance-checks work → claims inside scope →");
console.log("    verified verdict → release routes payoutHatId → intents/Poidh settle ═══");
