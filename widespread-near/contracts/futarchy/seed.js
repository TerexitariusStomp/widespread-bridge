// seed.js — run a full futarchy governance cycle on the deployed contract:
// propose → buy YES/NO shares → resolve on a metric → redeem.
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";

const c = JSON.parse(readFileSync(path.join(os.homedir(), ".foreguild-futarchy.json")));
const RPC = "https://rpc.testnet.near.org";
const account = new Account(c.accountId, RPC, new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const T = "30000000000000"; // 30 Tgas
const yN = (n) => BigInt(Math.round(parseFloat(n) * 1e24));

const call = (methodName, args, deposit = 0n) =>
  account.callFunction({
    contractId: c.accountId, methodName, args,
    gas: BigInt(T), deposit,
  }).then((r) => {
    if (r !== null && typeof r === "object") return r; // near-api-js 7.x pre-parses
    const s = typeof r === "string" ? r : Buffer.from(r ?? "").toString();
    try { return JSON.parse(s); } catch { return s; }
  });

// 1) treasury gets funded (simulating accumulated market fees)
await call("fundTreasury", {}, yN("2")).catch(() => {});

// 2) propose: allocate treasury to audit-bounties if settled volume ≥ 0.5 NEAR
const pid = await call("propose", {
  title: "Allocate Q4 fees to audit-bounty vertical",
  metricId: "near:settled_volume",
  threshold: "500000000000000000000000", // 0.5 NEAR in yocto
  comparator: "gte",
  treasuryAction: { recipient: c.accountId, amount: "100000000000000000000000000" }, // 0.1 NEAR demo
  deadline: String(BigInt(Date.now()) * 1000000n + 7n * 24n * 3600n * 1000000000n),
});
console.log("proposal", pid, "— 'allocate fees if settled_volume >= 0.5 NEAR'");

// 3) agents trade: YES believers + NO skeptics
await call("buyShares", { proposalId: String(pid), side: "yes" }, yN("0.05"));
await call("buyShares", { proposalId: String(pid), side: "yes" }, yN("0.03"));
await call("buyShares", { proposalId: String(pid), side: "no" }, yN("0.02"));
console.log("traded: 0.08 YES / 0.02 NO");

// 4) resolve: metric reads 0.62 NEAR settled (≥0.5 → YES) — evidence = market listOpen
const res = await call("resolve", {
  proposalId: String(pid),
  metricValue: "620000000000000000000000",
  evidenceHash: "sha256:markets-1-5-settled-0.62near",
});
console.log("resolved:", JSON.stringify(res));

// 5) YES shareholders redeem
const rd = await call("redeem", { proposalId: String(pid) });
console.log("redeem:", JSON.stringify(rd));

// views for the record (raw RPC — view methods aren't transactions)
const view = await fetch(RPC, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
    params: { request_type: "call_function", finality: "final",
      account_id: c.accountId, method_name: "getProposal",
      args_base64: btoa(JSON.stringify({ proposalId: String(pid) })) } }),
}).then((x) => x.json());
console.log("getProposal →", view.result?.result
  ? Buffer.from(view.result.result).toString().slice(0, 400) : JSON.stringify(view).slice(0, 300));
