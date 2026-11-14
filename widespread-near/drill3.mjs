import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));
const commit = process.argv[2];
const claimHash = "sha256:" + createHash("sha256").update("docs cmd prints https://widespread.fyi/mcp exit 0").digest("hex");
const r = await acct.callFunction({ contractId: creds.accountId, methodName: "shipClaim",
  args: { marketId: "2", claimHash, actor: "widespread-ops",
    commits: [commit],
    evidence: { deliverable: "widespread-mcp `docs` command: prints remote MCP endpoint https://widespread.fyi/mcp and exits 0. Added in cli subcommands; verified locally.",
      commit, repo: "TerexitariusStomp/widespread-bridge" },
    claimant: creds.accountId, attested: true },
  gas: 100000000000000n, deposit: 10000000000000000000000n });
console.log("claim 2 on market 2:", JSON.stringify(r).slice(0, 120));
