import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

const sha = "f19cea9436aa8be47115254a108c8c82955981e8";
const claimHash = "sha256:" + createHash("sha256").update("docs-cmd-clean-" + sha).digest("hex");
const r = await acct.callFunction({ contractId: creds.accountId, methodName: "shipClaim",
  args: { marketId: "2", claimHash, actor: "widespread-ops",
    commits: [sha],
    evidence: { deliverable: "Adds `docs` subcommand to widespread-mcp CLI printing the remote MCP endpoint URL and exiting 0. Clean commit, work only.",
      commit: sha, repo: "TerexitariusStomp/widespread-bridge",
      verification: "uvx run docs → https://widespread.fyi/mcp, exit 0" },
    claimant: creds.accountId, attested: true },
  gas: 100000000000000n, deposit: 20000000000000000000000n });
console.log("claim:", JSON.stringify(r).slice(0, 80));
