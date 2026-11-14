// release.js — oracle-side: register the oracle pubkey on-chain, then call
// release() with a signed verdict so the contract pays the claimant.
// Usage:
//   node src/release.js register <oraclePubkeyHex>
//   node src/release.js settle <marketId> <verdictSigHex> <oraclePubkeyHex>
//   node src/release.js claim  <marketId> <claimHash> <commitsCsv>
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";
import crypto from "crypto";

const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const account = new Account(c.accountId, "https://rpc.testnet.near.org",
                            new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const [cmd, ...rest] = process.argv.slice(2);

async function call(methodName, args, deposit = "0") {
  return account.callFunction({
    contractId: c.accountId, methodName, args,
    gas: BigInt("30000000000000"), deposit: BigInt(deposit),
  });
}

async function view(methodName, args = {}) {
  const r = await fetch("https://rpc.testnet.near.org", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: c.accountId, method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  }).then((x) => x.json());
  const b = r.result?.result;
  return b ? JSON.parse(Buffer.from(b).toString()) : r;
}

if (cmd === "register") {
  const [pubkey] = rest;
  console.log("registerOracle →", await call("registerOracle", { pubkey }));
  console.log("oracle →", JSON.stringify(await view("getOracle", { pubkey })));
} else if (cmd === "keygen") {
  // mint an oracle signing key — seed+pub hex go into wrangler secrets.
  const seed = crypto.randomBytes(32);
  const kp = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  // spki raw pubkey = last 32 bytes of the DER blob.
  const pub = kp.publicKey.subarray(-32);
  console.log(JSON.stringify({ seedHex: seed.toString("hex"), pubkeyHex: pub.toString("hex") }));
} else if (cmd === "claim") {
  const [marketId, claimHash, commitsCsv] = rest;
  console.log("shipClaim →", await call("shipClaim", {
    marketId, claimHash, actor: c.accountId,
    commits: (commitsCsv || "").split(",").filter(Boolean), evidence: "dg-ship-1",
  }));
} else if (cmd === "settle") {
  const [marketId, verdictSig, oraclePubkey] = rest;
  console.log("release →", JSON.stringify(await call("release", {
    marketId, verdictSig, oraclePubkey,
  })).slice(0, 400));
  console.log("market →", JSON.stringify(await view("getMarket", { marketId })).slice(0, 400));
} else if (cmd === "market") {
  console.log(JSON.stringify(await view("getMarket", { marketId: rest[0] })));
} else {
  console.log("commands: keygen | register <pub> | claim <id> <hash> <commits> | settle <id> <sig> <pub> | market <id>");
}
