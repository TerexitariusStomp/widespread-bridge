import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

// market 2 — no oracleAllowlist: every active seat can vote
const spec = "Add a `docs` command to widespread-mcp's CLI that prints the remote MCP endpoint URL and exits 0.";
await acct.callFunction({ contractId: creds.accountId, methodName: "createMarket",
  args: { specHash: "sha256:" + createHash("sha256").update(spec).digest("hex"),
    spec, oracleQuorumM: 1 },
  gas: 50000000000000n, deposit: 100000000000000000000000n });

const claimHash = "sha256:" + createHash("sha256").update("docs cmd: prints https://widespread.fyi/mcp, exit 0").digest("hex");
await acct.callFunction({ contractId: creds.accountId, methodName: "shipClaim",
  args: { marketId: "2", claimHash, actor: "widespread-ops",
    commits: ["07272e907f807c79d008984bfb6553c244ef7217"],
    evidence: { deliverable: "widespread-mcp smoke: tools 50, wide_bounties ok via https://widespread.fyi/mcp — npm run smoke exits 0",
      commit: "07272e907f807c79d008984bfb6553c244ef7217", repo: "TerexitariusStomp/widespread-bridge" },
    claimant: creds.accountId, attested: true },
  gas: 100000000000000n, deposit: 10000000000000000000000n });
console.log("market 2 + claim ready");
