// deploy.js — create a NEAR testnet account + deploy contract.wasm.
// Usage: node deploy.js [account-id.testnet]
// Key saved to ~/.foreguild-futarchy.json
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";

const CREDS = path.join(os.homedir(), ".foreguild-futarchy.json");
const wasm = readFileSync(new URL("./contract.wasm", import.meta.url));

const cfg = {
  nodeUrl: "https://rpc.testnet.near.org",
  helperUrl: "https://helper.testnet.near.org",
};

async function main() {
  let accountId, keyPair;
  if (existsSync(CREDS)) {
    const c = JSON.parse(readFileSync(CREDS, "utf8"));
    accountId = c.accountId;
    keyPair = KeyPair.fromString(c.secretKey);
    console.log(`reusing ${accountId}`);
  } else {
    accountId =
      process.argv[2] ||
      `foreguild-ft-${Math.floor(Math.random() * 1e6)}.testnet`;
    keyPair = KeyPair.fromRandom("ed25519");
    const res = await fetch(
      `${cfg.helperUrl}/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newAccountId: accountId,
          newAccountPublicKey: keyPair.getPublicKey().toString(),
        }),
      });
    if (!res.ok) {
      const t = await res.text();
      if (!t.includes("already")) {
        console.error(`account create failed: ${res.status} ${t}`);
        process.exit(1);
      }
      console.log(`account ${accountId} exists — funding via faucet`);
    }
    writeFileSync(CREDS, JSON.stringify({
      accountId, secretKey: keyPair.toString(),
    }));
    console.log(`created ${accountId}`);
  }

  const account = new Account(accountId, cfg.nodeUrl, new KeyPairSigner(keyPair));
  console.log("deploying contract.wasm …");
  await account.deployContract(wasm);
  console.log(`deployed → https://testnet.nearblocks.io/address/${accountId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
