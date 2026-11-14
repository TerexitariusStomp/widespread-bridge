// bootstrap-mainnet.mjs — mainnet bring-up, take 2.
// Reads ALL secrets from ~/.widespread-near-mainnet.json — nothing on the
// command line, nothing printed. Deploys the contract onto the implicit
// account itself (implicit accounts can't host subaccounts), registers a
// bonded oracle seat, sets the arbitrator, opens the first real market.
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync, writeFileSync } from "fs";
import os from "os"; import path from "path";

const RPC = "https://rpc.mainnet.near.org";
const CREDS = path.join(os.homedir(), ".widespread-near-mainnet.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const ACCT = creds.accountId;
const WASM = new URL("../contracts/market-rs/target/wasm32-unknown-unknown/release/widespread_market.opt.wasm", import.meta.url).pathname;

const provider = new JsonRpcProvider({ url: RPC });
const acct = new Account(ACCT, provider, new KeyPairSigner(KeyPair.fromString(creds.secretKey)));
const y = (n) => BigInt(Math.round(n * 1e24));
const call = (methodName, args = {}, deposit = "0") =>
  acct.callFunction({ contractId: ACCT, methodName, args,
    gas: BigInt("30000000000000"), deposit: BigInt(deposit) });
const view = async (m, a = {}) => {
  const r = await fetch(RPC, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: ACCT, method_name: m,
        args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return JSON.parse(Buffer.from(d.result.result).toString());
};

// 1. deploy contract (skip if code already present)
const codeHash = await fetch(RPC, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query",
    params: { request_type: "view_account", finality: "final", account_id: ACCT } }) })
  .then(r => r.json()).then(d => d.result?.code_hash);
if (codeHash && codeHash !== "11111111111111111111111111111111") {
  console.log("· contract already deployed:", codeHash.slice(0, 16));
} else {
  console.log("· deploying wasm…");
  await acct.deployContract(readFileSync(WASM));
  console.log("· deployed");
}

// 2. oracle seat — keypair generated + persisted to creds BEFORE the tx
let oracleKp;
if (creds.oracle?.secretKey) {
  oracleKp = KeyPair.fromString(creds.oracle.secretKey);
} else {
  oracleKp = KeyPair.fromRandom("ed25519");
  creds.oracle = { pubkey: oracleKp.getPublicKey().toString(), secretKey: oracleKp.toString() };
  writeFileSync(CREDS, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
const oraclePub = creds.oracle.pubkey;
const existing = await view("listOracles").catch(() => []);
if (!existing.some(o => o.pubkey === oraclePub)) {
  await call("registerOracle", { pubkey: oraclePub }, String(y(0.1)));
  console.log("· oracle seat bonded 0.1 NEAR");
} else console.log("· oracle seat exists");

// 3. arbitrator = contract account
const cfg = await view("getConfig");
if (cfg.arbitrator !== ACCT) {
  await call("setArbitrator", { account: ACCT });
  console.log("· arbitrator set");
} else console.log("· arbitrator already set");

// 4. first real market — 0.5 NEAR escrow, quorum 1, allowlist our seat
let markets = await view("listAll");
if (markets.length === 0) {
  const spec = "Ship a working `npm run smoke` for widespread-mcp: starts the " +
    "stdio server, calls wide_bounties via the remote catalog, exits 0 with " +
    "the tool count printed. PR into the monorepo.";
  const marketId = await call("createMarket", {
    spec, specHash: "sha256:bootstrap-smoke",
    oracleQuorumM: 1, oracleAllowlist: [oraclePub],
  }, String(y(0.5)));
  console.log("· market", marketId, "escrowed 0.5 NEAR");
} else console.log("· markets exist:", markets.length);

console.log("config:", JSON.stringify(await view("getConfig")));
console.log("oracles:", JSON.stringify(await view("listOracles")));
console.log("\n✓ mainnet live — contract", ACCT);
