// live.test.mjs — LIVE testnet E2E for the market contract.
// Gated: E2E_LIVE=1. Uses the deploy keypair at ~/.widespread-near.json
// (the contract account itself acts as payer — testnet only).
// Creates a real market, ships claims, releases, verifies on-chain state.
// Follows the repo's own callFunction + raw-query pattern (near-api-js v7).
//
//   E2E_LIVE=1 node --test test/live.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { Account, KeyPair, KeyPairSigner } from "near-api-js";

const LIVE = process.env.E2E_LIVE === "1";
const CREDS = path.join(os.homedir(), ".widespread-near.json");
const NODE = "https://rpc.testnet.near.org";

function loadAccount() {
  if (!existsSync(CREDS)) throw new Error(`no creds at ${CREDS} — run contracts/market-legacy/deploy.js first`);
  const c = JSON.parse(readFileSync(CREDS, "utf8"));
  return { accountId: c.accountId,
    account: new Account(c.accountId, NODE, new KeyPairSigner(KeyPair.fromString(c.secretKey))) };
}

async function view(accountId, methodName, args = {}) {
  const r = await fetch(NODE, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: accountId, method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  }).then((x) => x.json());
  const b = r.result?.result;
  return b ? JSON.parse(Buffer.from(b).toString()) : r;
}

test("live: full market lifecycle on testnet", { skip: !LIVE }, async () => {
  const { accountId, account } = loadAccount();
  const call = (methodName, args, deposit = "0") =>
    account.callFunction({ contractId: accountId, methodName, args,
      gas: BigInt("30000000000000"), deposit: BigInt(deposit) });
  const v = (m, a) => view(accountId, m, a);

  const before = await v("listAll");
  const marketCount = before.length;

  // payer locks a tiny bounty (0.01 NEAR — testnet funds are scarce)
  const specHash = `sha256:e2e-${Date.now()}`;
  const marketId = await call("createMarket", {
    specHash, spec: "e2e lifecycle proof", deadline: null,
    acceptanceRule: "best", platformBps: 1000, platformTo: "widespread-dao.near",
    payToHat: null, claimTtlNs: null, acceptanceHash: null,
  }, "10000000000000000000000"); // 0.01 NEAR
  assert.ok(marketId, "createMarket returned id");

  const market = await v("getMarket", { marketId });
  assert.equal(market.status, "open");
  assert.equal(market.specHash, specHash);
  assert.equal(market.platformBps, 1000);

  // two competing claims — one attested, one not
  await call("shipClaim", {
    marketId, claimHash: "e2e-win", actor: "e2e-agent",
    commits: ["deadbeef"], evidence: { e2e: true },
    claimant: accountId, forgeId: "e2e", forgeUserId: "1",
    relayer: "e2e-test", attested: true,
  });
  await call("shipClaim", {
    marketId, claimHash: "e2e-lose", actor: "e2e-agent-2",
    commits: [], evidence: {}, claimant: accountId, attested: false,
  });

  const claims = await v("getClaims", { marketId });
  assert.equal(claims.total, 2);
  assert.equal(claims.pending, 2);
  const winner = claims.claims.find((c) => c.claimHash === "e2e-win");
  const loser = claims.claims.find((c) => c.claimHash === "e2e-lose");
  assert.ok(winner && loser);

  // payer releases to the attested winner — no oracle needed
  const result = await call("release", {
    marketId, verdictSig: null, oraclePubkey: null,
    winningClaimId: winner.claimId,
  });
  assert.equal(result.paid, accountId);
  assert.ok(BigInt(result.platformCut) > 0n, "platform cut taken");

  // on-chain truth: market paid, winner won, loser outcompeted
  const after = await v("getMarket", { marketId });
  assert.equal(after.status, "paid");
  assert.equal(after.winningClaimId, winner.claimId);
  const claimsAfter = await v("getClaims", { marketId });
  const w = claimsAfter.claims.find((c) => c.claimId === winner.claimId);
  const l = claimsAfter.claims.find((c) => c.claimId === loser.claimId);
  assert.equal(w.status, "won");
  assert.equal(l.status, "outcompeted");

  const all = await v("listAll");
  assert.equal(all.length, marketCount + 1);
  console.log(`live e2e ok — market ${marketId} paid on ${accountId}`);
});
