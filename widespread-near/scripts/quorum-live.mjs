import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { actions } from "near-api-js";
const { createAccount: createAccountAction, transfer, addFullAccessKey } = actions;
import { readFileSync, writeFileSync } from "fs";
import os from "os"; import path from "path";
import crypto from "crypto";

const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const rpc = "https://test.rpc.fastnear.com";
const account = new Account(c.accountId, rpc, new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const CONTRACT = c.accountId;

// second oracle seat: fresh account via implicit-account trick won't
// work — create a subaccount of the contract account
const O2 = `oracle4.${CONTRACT}`;
let o2key;
try {
  const saved = JSON.parse(readFileSync("/tmp/o2.json", "utf8"));
  o2key = saved.accountId === O2 ? KeyPair.fromString(saved.secretKey) : KeyPair.fromRandom("ed25519");
} catch { o2key = KeyPair.fromRandom("ed25519"); }
await account.signAndSendTransaction({ receiverId: O2, actions: [
  createAccountAction(), transfer(BigInt("200000000000000000000000")),
  addFullAccessKey(o2key.getPublicKey()),
]}).then(() => console.log("o2 created")).catch(e => console.log("o2 exists?", String(e).slice(0,160)));
const o2 = new Account(O2, rpc, new KeyPairSigner(o2key));
writeFileSync("/tmp/o2.json", JSON.stringify({ accountId: O2, secretKey: o2key.toString() }));
console.log("oracle2 account:", O2);

const call = (acct, method, args, deposit = 0n) =>
  acct.callFunction({ contractId: CONTRACT, methodName: method, args,
    gas: BigInt("30000000000000"), deposit });
const view = async (m, a = {}) => {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) }).then(x => x.json());
  const b = r.result?.result;
  return b ? JSON.parse(Buffer.from(b).toString()) : r;
};

// 1. quorum=2 market, 0.05 NEAR escrow
const specHash = "sha256:" + crypto.randomBytes(8).toString("hex");
const marketId = await call(o2, "createMarket",
  { specHash, spec: "quorum test", deadline: null, acceptanceRule: "best",
    oracleQuorumM: 2 }, BigInt("50000000000000000000000"));
console.log("market:", marketId, "quorum=2");

// 2. attested claim
const claimId = await call(o2, "shipClaim",
  { marketId: String(marketId), claimHash: "live-q2-claim", actor: "dev",
    commits: ["abc123"], evidence: {}, claimant: account.accountId, attested: true });
console.log("claim:", claimId);

// 3. register second oracle
const pk2 = crypto.randomBytes(32).toString("hex");
await call(o2, "registerOracle", { pubkey: pk2 });
console.log("oracle2 registered:", pk2.slice(0, 12));

// 4. first vote (seat 1 = contract account, oracle pk already registered)
const PK1 = "1ad812e3b4a566d8a33358529adc431e3c752b6a0c2ca3fa70d92ee1423e0ef1";
const v1 = await call(account, "submitVerdict",
  { marketId: String(marketId), claimId: String(claimId), verdict: "accept",
    oraclePubkey: PK1, verdictSig: "live-test" });
console.log("vote 1:", JSON.stringify(v1));

// 5. release attempt at 1-of-2 → must FAIL
try {
  await call(account, "release", { marketId: String(marketId), winningClaimId: String(claimId) });
  console.log("RELEASE AT 1-OF-2 — BUG!");
} catch (e) { console.log("release correctly refused at 1-of-2:", String(e).slice(0,110)); }

// 6. second oracle votes → quorum; anyone releases
await call(o2, "submitVerdict",
  { marketId: String(marketId), claimId: String(claimId), verdict: "accept",
    oraclePubkey: pk2, verdictSig: "live-test-2" });
console.log("vote 2 cast");
const rel = await call(account, "release", { marketId: String(marketId), winningClaimId: String(claimId) });
console.log("RELEASE:", JSON.stringify(rel).slice(0, 300));
console.log("tally:", JSON.stringify(await view("getVerdicts", { marketId: String(marketId) })));
