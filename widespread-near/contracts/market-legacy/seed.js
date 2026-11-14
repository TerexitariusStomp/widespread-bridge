// seed.js — create a funded market on the deployed contract.
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";
const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const account = new Account(c.accountId, "https://rpc.testnet.near.org",
                            new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const res = await account.callFunction({
  contractId: c.accountId, methodName: "createMarket",
  args: {
    specHash: "sha256:" + "0".repeat(64),
    spec: "Add a /api/markets endpoint test — demonstrate on-chain escrow",
    deadline: String(BigInt(Date.now()) * 1000000n + 7n*24n*3600n*1000000000n),
    acceptanceRule: "patch-id match on merged commit",
  },
  gas: BigInt("30000000000000"),
  deposit: BigInt("100000000000000000000000"), // 0.1 NEAR escrow
});
console.log("createMarket →", JSON.stringify(res).slice(0, 300));
const r = await fetch("https://rpc.testnet.near.org", {
  method: "POST", headers: {"content-type":"application/json"},
  body: JSON.stringify({jsonrpc:"2.0",id:"w",method:"query",
    params:{request_type:"call_function",finality:"final",
      account_id:c.accountId,method_name:"listOpen",args_base64:btoa("{}")}}),
}).then(x=>x.json());
const bytes = r.result?.result;
console.log("listOpen →", bytes ? Buffer.from(bytes).toString().slice(0,400) : r);
