import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

// market 3 — no oracleAllowlist: every active seat can vote (video Beat-5 market)
const spec = "Render the adjudication panel's per-judge reasoning on the /market/{id} case file page of widespread.fyi, so verdicts show why each seat voted.";
await acct.callFunction({ contractId: creds.accountId, methodName: "createMarket",
  args: { specHash: "sha256:" + createHash("sha256").update(spec).digest("hex"),
    spec, oracleQuorumM: 1 },
  gas: 50000000000000n, deposit: 100000000000000000000000n });
console.log("market 3 created, 0.1 NEAR escrowed");
