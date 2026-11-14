import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { createHash } from "node:crypto";
import { homedir } from "os";
import { join } from "path";
import { ed25519 } from "@noble/curves/ed25519.js";

const creds = JSON.parse(readFileSync(join(homedir(), ".widespread-near-mainnet.json"), "utf8"));
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
const admin = new Account(creds.accountId, provider, KeyPairSigner.fromSecretKey(creds.secretKey));

// operator implicit account — Worker holds ONLY this key
const opKp = KeyPair.fromRandom("ed25519");
const opAcct = Buffer.from(opKp.getPublicKey().data).toString("hex");

// verdict signing seed — the seat's on-chain pubkey is its hex form
const seed = crypto.getRandomValues(new Uint8Array(32));
const seedHex = Buffer.from(seed).toString("hex");
const pubHex = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");

// persist creds BEFORE any tx
const cf = join(homedir(), ".widespread-near-oracle.json");
writeFileSync(cf, JSON.stringify({
  accountId: opAcct, secretKey: opKp.toString(),
  oraclePubkeyHex: pubHex, oracleSeedHex: seedHex,
}));
chmodSync(cf, 0o600);
console.log("operator account:", opAcct);
console.log("seat pubkey hex:", pubHex);

// fund operator: 0.1 bond + 0.2 gas reserve
const { actionCreators } = await import("near-api-js").then(m => ({ actionCreators: m.actions }));
await admin.signAndSendTransaction({ receiverId: opAcct,
  actions: [actionCreators.transfer(300000000000000000000000n)] });
console.log("funded 0.3 NEAR");

// register the seat from the operator account — it owns the seat
const op = new Account(opAcct, provider, KeyPairSigner.fromSecretKey(opKp.toString()));
await op.callFunction({ contractId: creds.accountId, methodName: "registerOracle",
  args: { pubkey: pubHex }, gas: 30000000000000n,
  deposit: 100000000000000000000000n });
console.log("seat registered + bonded");
