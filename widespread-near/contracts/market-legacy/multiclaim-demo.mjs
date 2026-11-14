// multiclaim-demo.mjs — e2e proof of unbounded multi-claim markets:
// payer funds → 2 agents ship claims (unbounded) → verdict names winner →
// loser recorded "outcompeted" → getClaims shows both. Run: node multiclaim-demo.mjs
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";

const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const RPC = "https://rpc.testnet.near.org";
const account = new Account(c.accountId, RPC, new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const GAS = BigInt("30000000000000");

const call = (methodName, args, deposit = 0n) => account.callFunction({
  contractId: c.accountId, methodName, args,
  gas: GAS, deposit: BigInt(deposit),
});
const view = async (methodName, args) => {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: c.accountId, method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) }).then(x => x.json());
  const bytes = res.result?.result;
  return bytes ? JSON.parse(Buffer.from(bytes).toString()) : res;
};

// 1. fund a market
const decode = (r) => {
  if (r == null || typeof r === "object") return r;
  const v = r?.result ?? r;
  if (v == null) return null;
  if (typeof v === "object") return v;
  const s = typeof v === "string" ? v : Buffer.from(v).toString();
  try { return JSON.parse(s); } catch { return s; }
};

// 1. fund a market
const marketId2 = decode(await call("createMarket", {
  specHash: "sha256:" + "e".repeat(64),
  spec: "multiclaim e2e market",
  deadline: String(BigInt(Date.now()) * 1000000n + 24n * 3600n * 1000000000n),
  acceptanceRule: "best verified wins",
  claimTtlNs: String(24n * 3600n * 1000000000n),
}, "50000000000000000000000"));
console.log("market created:", marketId2);
const mid = String(marketId2);

// 2. two competing claims — same account here (forge-uniqueness is bridge-side)
const mkClaim = (n, attested) => ({
  marketId: mid, claimHash: "sha256:" + String(n).repeat(64).slice(0, 64),
  actor: `agent-${n}`, commits: [`abc${n}`],
  evidence: { patchId: `patch-${n}`, forgeRef: `https://github.com/x/y/pull/${n}` },
  claimant: `claimant-${n}.testnet`,
  forgeId: "github", forgeUserId: `999${n}`, relayer: "widespread-bridge",
  attested,
});
const c1 = decode(await call("shipClaim", mkClaim(1, true)));
const c2 = decode(await call("shipClaim", mkClaim(2, true)));
const c3 = decode(await call("shipClaim", mkClaim(3, false)));
console.log("claims shipped:", c1, c2, c3, "(3rd unattested — spam path)");

// 3. claims view
const claims = await view("getClaims", { marketId: mid });
console.log("getClaims:", JSON.stringify(claims).slice(0, 400));

// 4. verdict: payer picks claim 2 (oracle path would require attested=true)
const rel = await call("release", { marketId: mid, winningClaimId: c2 });
console.log("release:", decode(rel));

// 5. post-release state
const m = await view("getMarket", { marketId: mid });
console.log("market:", m.status, "paidTo:", m.paidTo, "winningClaimId:", m.winningClaimId);
const after = await view("getClaims", { marketId: mid });
console.log("claim statuses:", after.claims.map(x => `${x.claimId}:${x.status}`).join(", "));
