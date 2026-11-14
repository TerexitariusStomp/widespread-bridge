import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const acct = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

const diff = `diff --git a/widespread-mcp/widespread_mcp/server.py b/.../server.py
@@ def main():
     sub = p.add_subparsers(dest="cmd")
     sub.add_parser("serve", help="stdio MCP server (default)")
+    sub.add_parser("docs", help="print the remote MCP endpoint and exit")
     a = p.parse_args()
+    if a.cmd == "docs":
+        from ._widespread import BRIDGE
+        print(f"{BRIDGE}/mcp")
+        return
     if a.cmd in (None, "serve"):
         make_server().run(transport="stdio")
         return
# output: $ widespread-mcp docs → https://widespread.fyi/mcp (exit 0)`;

const claimHash = "sha256:" + createHash("sha256").update(diff).digest("hex");
const r = await acct.callFunction({ contractId: creds.accountId, methodName: "shipClaim",
  args: { marketId: "2", claimHash, actor: "widespread-ops",
    commits: ["418c635cd2f0bd333a1ac7e2c617cb660f2f8e51"],
    evidence: { deliverable: diff,
      commit: "418c635cd2f0bd333a1ac7e2c617cb660f2f8e51",
      repo: "TerexitariusStomp/widespread-bridge",
      verification: "ran locally: prints endpoint, exits 0" },
    claimant: creds.accountId, attested: true },
  gas: 100000000000000n, deposit: 50000000000000000000000n });
console.log("claim 3:", JSON.stringify(r).slice(0, 120));
