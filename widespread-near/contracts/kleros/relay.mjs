// kleros-relay — watches WidespreadArbitrable Ruling events on the EVM
// chain and posts resolveDispute on NEAR from the configured proxy
// account. A liveness relay, not an authority: the ruling comes from the
// Kleros court's on-chain event; this just transports it. Anyone can run
// one — censorship is detectable (Ruling emitted, no NEAR tx follows).
//
// Env:
//   EVM_RPC            e.g. Arbitrum Sepolia RPC
//   ARBITRABLE         deployed WidespreadArbitrable address
//   NEAR_PROXY_ACCOUNT the market contract's arbitrator account
//                      (e.g. kleros-proxy.wide-mkt-11561.testnet)
//   NEAR_PROXY_KEY     ed25519:<base58> key for the proxy account
//   NEAR_CONTRACT      market contract account id
//   NEAR_RPC_URL       default https://rpc.testnet.fastnear.com
//   POLL_S             default 120
//   FROM_BLOCK         resume point (default: latest)
import { createPublicClient, http, parseAbiItem } from "viem";
import { Account, KeyPair, KeyPairSigner } from "near-api-js";

const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`missing env ${k}`); process.exit(1); } return env[k]; };

const client = createPublicClient({ transport: http(need("EVM_RPC")) });
const ARBITRABLE = need("ARBITRABLE");
const NEAR_CONTRACT = need("NEAR_CONTRACT");
const NEAR_RPC = env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const POLL = Number(env.POLL_S ?? 120) * 1000;
const GAS = BigInt("100000000000000");

const near = new Account(need("NEAR_PROXY_ACCOUNT"), NEAR_RPC,
  new KeyPairSigner(KeyPair.fromString(need("NEAR_PROXY_KEY"))));

const RULED_ABI = parseAbiItem("event Ruling(uint256 indexed disputeID, uint256 indexed ruling)");
const ARBITRABLE_ABI = [{
  type: "function", name: "nearRuling", stateMutability: "view",
  inputs: [{ name: "disputeID", type: "uint256" }],
  outputs: [{ name: "rulingName", type: "string" }],
}, {
  type: "function", name: "cases", stateMutability: "view",
  inputs: [{ name: "disputeID", type: "uint256" }],
  outputs: [
    { name: "marketId", type: "string" }, { name: "claimId", type: "string" },
    { name: "ruling", type: "uint256" }, { name: "ruled", type: "bool" }, { name: "exists", type: "bool" },
  ],
}];

// Relayed rulings — idempotent: a ruling already posted on-chain (docket
// shows resolved) is skipped. Persisted to survive restarts.
const seen = new Set();
async function alreadyResolved(marketId, claimId) {
  const r = await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "r", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: NEAR_CONTRACT,
        method_name: "getDisputes", args_base64: Buffer.from(JSON.stringify({ marketId })).toString("base64") } }) })
    .then((x) => x.json()).catch(() => null);
  const rows = r?.result?.result ? JSON.parse(Buffer.from(r.result.result).toString()) : [];
  return rows.some((d) => d.claimId === (claimId || "") && d.status !== "open");
}

async function relay(disputeID) {
  const [c, rulingName] = await Promise.all([
    client.readContract({ address: ARBITRABLE, abi: ARBITRABLE_ABI, functionName: "cases", args: [disputeID] }),
    client.readContract({ address: ARBITRABLE, abi: ARBITRABLE_ABI, functionName: "nearRuling", args: [disputeID] }),
  ]);
  const [marketId, claimId, , ruled, exists] = c;
  if (!exists || !ruled || !rulingName) return;
  if (await alreadyResolved(marketId, claimId)) { seen.add(String(disputeID)); return; }
  const res = await near.callFunction({
    contractId: NEAR_CONTRACT, methodName: "resolveDispute",
    args: { marketId, claimId: claimId || null, ruling: rulingName },
    gas: GAS, deposit: 0n,
  });
  console.log(`relayed dispute ${disputeID}: ${marketId}/${claimId || "*"} → ${rulingName}`,
    res?.transaction_outcome?.id ?? "");
  seen.add(String(disputeID));
}

async function poll() {
  const logs = await client.getLogs({ address: ARBITRABLE, event: RULED_ABI, fromBlock: "earliest" });
  for (const log of logs) {
    const id = String(log.args.disputeID);
    if (!seen.has(id)) await relay(log.args.disputeID).catch((e) =>
      console.log(`dispute ${id}: ${String(e).slice(0, 140)}`));
  }
}

console.log(`kleros-relay: ${ARBITRABLE} → ${NEAR_CONTRACT} via ${near.accountId}`);
for (;;) { await poll().catch((e) => console.log("poll error:", String(e).slice(0, 160))); await new Promise((r) => setTimeout(r, POLL)); }
