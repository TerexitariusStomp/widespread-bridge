// deploy-mainnet.mjs — deploy the wide-mkt escrow contract to NEAR mainnet.
//
// Requires a FUNDED mainnet account you control:
//   NEAR_ACCOUNT=youracct.near  NEAR_KEY=ed25519:<base58-secret-key>
//   node scripts/deploy-mainnet.mjs
//
// Deploys the Rust market wasm to a dedicated subaccount
// (wide-mkt.<account>) — funded from the main account — and calls
// init(oracle) if the contract isn't initialised.
// Dry-run first: DRY_RUN=1 prints the plan only.
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const RPC = process.env.NEAR_RPC ?? "https://rpc.mainnet.near.org";
const FUNDER = process.env.NEAR_ACCOUNT;
const KEY = process.env.NEAR_KEY;
if (!FUNDER || !KEY) {
  console.error("Set NEAR_ACCOUNT + NEAR_KEY=ed25519:<base58> (funded mainnet account)");
  process.exit(1);
}
const WASM = path.join(path.dirname(fileURLToPath(import.meta.url)),
  "../contracts/market-rs/target/wasm32-unknown-unknown/release/widespread_market.opt.wasm");
const ORACLE = process.env.ORACLE_ACCOUNT ?? FUNDER; // oracle/adjudicator acct
const CONTRACT_ID = process.env.CONTRACT_ID ?? `wide-mkt.${FUNDER}`;

const provider = new JsonRpcProvider({ url: RPC });

const signer = new KeyPairSigner(KeyPair.fromString(KEY));
const acct = new Account(FUNDER, provider, signer);
const sub = new Account(CONTRACT_ID, provider, signer);

console.log(`deploy plan:
  contract:  ${CONTRACT_ID}
  funder:    ${FUNDER}
  oracle:    ${ORACLE}
  wasm:      ${WASM}`);
if (process.env.DRY_RUN) process.exit(0);

// 1. create the contract subaccount (2.6 NEAR storage) — skip if it exists
const exists = await fetch(RPC, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "w", method: "query",
    params: { request_type: "view_account", finality: "final",
      account_id: CONTRACT_ID } }) }).then(r => r.json())
  .then(d => !d.error && d.result?.amount !== undefined);
if (exists) {
  console.log("· contract account exists — skipping create");
} else {
  console.log("· creating contract account (2.6 NEAR)…");
  await acct.createAccount({ newAccountId: CONTRACT_ID,
    publicKey: signer.getPublicKey(), nearToTransfer: 2600000000000000000000000n });
}

// 2. deploy wasm
console.log("· deploying wasm…");
await sub.deployContract(readFileSync(WASM));

// 3. init — idempotent guard: listOpen should return [] not panic
try {
  await provider.callFunction({ contractId: CONTRACT_ID, method: "listOpen", args: {} });
  console.log("· already initialised");
} catch {
  console.log("· init(oracle)…");
  await sub.callFunction({ contractId: CONTRACT_ID, method: "init",
    args: { oracle: ORACLE } });
}

console.log(`
✓ ${CONTRACT_ID} live on mainnet.

Next — point the bridge at it:
  wrangler.jsonc:  NEAR_CONTRACT="${CONTRACT_ID}"  NEAR_RPC_URL="${RPC}"
  wrangler deploy
Then seed one real escrow via POST /api/bounties and update SUBMISSION.md
with the tx hash.`);
