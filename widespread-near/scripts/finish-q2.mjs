import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";

const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const o2creds = JSON.parse(readFileSync("/tmp/o2.json", "utf8"));
const rpc = "https://test.rpc.fastnear.com";
const account = new Account(c.accountId, rpc, new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const o2 = new Account(o2creds.accountId, rpc, new KeyPairSigner(KeyPair.fromString(o2creds.secretKey)));
const CONTRACT = c.accountId;
const call = (acct, method, args, deposit = 0n) =>
  acct.callFunction({ contractId: CONTRACT, methodName: method, args,
    gas: BigInt("100000000000000"), deposit });
const view = async (m, a = {}) => {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) }).then(x => x.json());
  const b = r.result?.result;
  return b ? JSON.parse(Buffer.from(b).toString()) : r;
};

console.log("verdicts now:", JSON.stringify(await view("getVerdicts", { marketId: "22" })));
// pk2 = the oracle registered by o2 in the prior run — find it via the o2 account's oracle list? it's in the log: 44178a636956... full pk needed.
// re-derive: pk2 was random each run. Look up registered oracles and pick o2's.
const oracles = await view("listOracles");
console.log("oracles:", JSON.stringify(oracles));
const mine = oracles.find(o => o.owner === o2creds.accountId);
console.log("o2 oracle pubkey:", mine.pubkey);
const v2 = await call(o2, "submitVerdict",
  { marketId: "22", claimId: "1", verdict: "accept", oraclePubkey: mine.pubkey, verdictSig: "live-test-2" });
console.log("vote 2:", JSON.stringify(v2));
const rel = await call(account, "release", { marketId: "22", winningClaimId: "1" });
console.log("RELEASE:", JSON.stringify(rel).slice(0, 400));
console.log("market:", JSON.stringify(await view("getMarket", { marketId: "22" })).slice(0, 300));
