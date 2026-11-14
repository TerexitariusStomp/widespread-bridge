import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

const sha = "5bbc524"; // clean panel-reasoning commit (panel-claim branch)
const claimHash = "sha256:" + createHash("sha256").update("panel reasoning on /market/:id").digest("hex");
await acct.callFunction({ contractId: creds.accountId, methodName: "shipClaim",
  args: { marketId: "3", claimHash, actor: "widespread-ops",
    commits: [sha],
    evidence: { deliverable: "/market/:id case files render the ocv panel block — per-judge verdict/confidence/reasoning, live at widespread.fyi/market/2",
      commit: sha, repo: "TerexitariusStomp/widespread-bridge" },
    claimant: creds.accountId, attested: true },
  gas: 100000000000000n, deposit: 10000000000000000000000n });
console.log("claim filed on market 3");
