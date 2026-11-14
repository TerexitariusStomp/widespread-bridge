import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

const claimHash = "sha256:" + createHash("sha256")
  .update("widespread-mcp smoke: tools 50, wide_bounties ok via widespread.fyi").digest("hex");
const res = await acct.callFunction({ contractId: creds.accountId, methodName: "shipClaim",
  args: {
    marketId: "1",
    claimHash,
    actor: "widespread-ops",
    commits: ["07272e907f807c79d008984bfb6553c244ef7217"],
    evidence: {
      deliverable: "npm run smoke — stdio MCP handshake, tools/list=50, tools/call wide_bounties ok (exit 0). Served via https://widespread.fyi/mcp.",
      commit: "07272e907f807c79d008984bfb6553c244ef7217",
      repo: "TerexitariusStomp/widespread-bridge",
    },
    claimant: creds.accountId,
    attested: true,
  },
  gas: 100000000000000n, deposit: 10000000000000000000000n });
console.log("claim shipped:", JSON.stringify(res).slice(0, 200));
