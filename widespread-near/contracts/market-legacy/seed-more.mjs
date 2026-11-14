import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";
const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const account = new Account(c.accountId, "https://rpc.testnet.near.org",
                            new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const specs = [
  ["Add /healthz returning {ok,uptime,version} JSON", "0.05"],
  ["Write a README quickstart: clone → demo in under 5 minutes", "0.05"],
  ["Add vitest coverage for the verdict parser edge cases", "0.03"],
  ["Implement /api/locator docs + examples for rad:// and tangled remotes", "0.04"],
];
for (const [spec, near] of specs) {
  const deposit = BigInt(Math.round(parseFloat(near) * 1e24)).toString();
  try {
    const res = await account.callFunction({
      contractId: c.accountId, methodName: "createMarket",
      args: {
        specHash: "sha256:" + spec.split("").reduce((h,ch)=>((h*31+ch.charCodeAt(0))>>>0).toString(16).padStart(8,"0"),"").repeat(8).slice(0,64),
        spec, deadline: String(BigInt(Date.now())*1000000n + 14n*24n*3600n*1000000000n),
        acceptanceRule: "patch-id match on merged commit OR oracle verdict",
      },
      gas: BigInt("30000000000000"), deposit: BigInt(deposit),
    });
    console.log("OK", spec.slice(0,40), JSON.stringify(res).slice(0,120));
  } catch(e) { console.log("FAIL", spec.slice(0,40), String(e).slice(0,150)); }
}
