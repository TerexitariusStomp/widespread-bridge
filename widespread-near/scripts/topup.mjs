import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs"; import os from "os"; import path from "path";
const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const a = new Account(c.accountId, "https://test.rpc.fastnear.com", new KeyPairSigner(KeyPair.fromString(c.secretKey)));
await a.transfer({ receiverId: "oracle4.wide-mkt-11561.testnet", amount: BigInt("2000000000000000000000000") });
console.log("topped up 2N");
