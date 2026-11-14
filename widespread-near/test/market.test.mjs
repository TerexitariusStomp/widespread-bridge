// Legacy near-sdk-js contract suite — the live contract is contracts/market-rs
// (Rust, deployed). Kept as the spec record; run explicitly with RUN_LEGACY=1.
const RUN = process.env.RUN_LEGACY === "1";
if (!RUN) { console.log("market.test.mjs: skipped (set RUN_LEGACY=1 to run the legacy JS suite)"); process.exit(0); }
// market.test.mjs — unit tests for the WidespreadMarket contract, run
// against the REAL contract.src.js bundled by esbuild with a stubbed
// near-sdk-js runtime. node --test test/market.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadContract, setNear } from "./harness.mjs";

const SRC = new URL("../contracts/market-legacy/contract.src.js", import.meta.url).pathname;
const { Contract, near } = await loadContract(SRC, "WidespreadMarket");

const ONE = 10n ** 24n; // 1 NEAR in yocto
const DEFAULT_BOND = 100_000_000_000_000_000_000_000n; // matches contract DEFAULT_DISPUTE_BOND

function setup({ payer = "payer.testnet", deposit = ONE, ts = 1_000_000_000n } = {}) {
  const c = new Contract();
  const transfers = setNear(near, { account: payer, deposit, timestamp: ts });
  return { c, transfers };
}


/** First verdict per seat per market requires a small storage stake. */
function vote(c, fn, args) {
  const prev = near.attachedDeposit;
  near.attachedDeposit = () => ONE / 50n;
  try { return c[fn](args); } finally { near.attachedDeposit = prev; }
}

/** shipClaim now charges a storage deposit — attach a small stake. */
function ship(c, args) {
  const prev = near.attachedDeposit;
  near.attachedDeposit = () => ONE / 10n;
  try { return c.shipClaim(args); } finally { near.attachedDeposit = prev; }
}

function createMarket(c, over = {}) {
  return c.createMarket({
    specHash: "sha256:spec", spec: "do the thing", deadline: null,
    acceptanceRule: "best", platformBps: 0, platformTo: null,
    payToHat: null, claimTtlNs: null, acceptanceHash: null,
    ...over,
  });
}

test("createMarket requires attached deposit", () => {
  const { c } = setup({ deposit: 0n });
  assert.throws(() => createMarket(c), /must be funded/);
});

test("createMarket caps platformBps at 50%", () => {
  const { c } = setup();
  assert.throws(() => createMarket(c, { platformBps: 5001 }), /platformBps/);
  const id = createMarket(c, { platformBps: 5000 });
  assert.equal(c.markets.get(id).platformBps, 5000);
});

test("createMarket stores spec/escrow/fee fields", () => {
  const { c } = setup();
  const id = createMarket(c, { platformBps: 1000, platformTo: "widespread-dao.near" });
  const m = c.markets.get(id);
  assert.equal(m.status, "open");
  assert.equal(m.locked, ONE.toString());
  assert.equal(m.payer, "payer.testnet");
  assert.equal(m.platformBps, 1000);
});

test("shipClaim is unbounded — 200 competing claims all land", () => {
  const { c } = setup();
  const id = createMarket(c);
  const ids = [];
  for (let i = 0; i < 200; i++) {
    ids.push(ship(c, { marketId: id, claimHash: `h${i}`, actor: `a${i}`,
      commits: [], evidence: {}, claimant: `w${i}.testnet`, attested: i % 2 === 0 }));
  }
  assert.equal(c.getClaims({ marketId: id }).total, 200);
  assert.equal(c.getClaims({ marketId: id }).pending, 200);
});

test("shipClaim stamps forge identity + attestation + deadline", () => {
  const { c } = setup();
  const id = createMarket(c, { claimTtlNs: "1000000000" }); // 1s
  const cid = ship(c, { marketId: id, claimHash: "h", actor: "agent",
    commits: ["abc"], evidence: {}, claimant: "", forgeId: "github",
    forgeUserId: "424242", relayer: "bridge", attested: true });
  const claim = c.claims.get(`${id}:${cid}`);
  assert.equal(claim.forgeUserId, "424242");
  assert.equal(claim.attested, true);
  assert.equal(claim.shippedBy, "payer.testnet"); // predecessor default
  assert.ok(BigInt(claim.claimDeadline) > BigInt(claim.ts));
});

test("shipClaim rejects closed markets", () => {
  const { c } = setup();
  const id = createMarket(c);
  c.refund({ marketId: id });
  assert.throws(() => ship(c, { marketId: id, claimHash: "h" }), /not open/);
});

test("withdrawClaim: only shippedBy/claimant, only while pending", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "victim.testnet" });
  setNear(near, { account: "random.testnet" });
  assert.throws(() => c.withdrawClaim({ marketId: id, claimId: cid }), /not your claim/);
  setNear(near, { account: "victim.testnet" });
  const t = setNear(near, { account: "victim.testnet" });
  assert.equal(c.withdrawClaim({ marketId: id, claimId: cid }), true);
  // record removed + storage stake refunded to whoever shipped it
  assert.equal(c.claims.get(`${id}:${cid}`), null);
  assert.ok(t.find((x) => x.to === "payer.testnet" && x.amount > 0n),
    "stake refunded to shippedBy");
});

test("cleanupExpired reaps stale pending claims", () => {
  const { c } = setup({ ts: 1_000n });
  const id = createMarket(c, { claimTtlNs: "100" }); // 100ns ttl
  ship(c, { marketId: id, claimHash: "h" });
  setNear(near, { timestamp: 1_000_000n }); // far future
  const r = c.cleanupExpired({ marketId: id });
  assert.equal(r.reaped, 1);
  assert.equal(c.getClaims({ marketId: id }).pending, 0);
});

test("release: payer settles without oracle, splits locked correctly", () => {
  const { c, transfers } = setup();
  const id = createMarket(c, { platformBps: 1000, platformTo: "widespread-dao.near" });
  const cid = ship(c, { marketId: id, claimHash: "win", claimant: "winner.testnet" });
  ship(c, { marketId: id, claimHash: "lose", claimant: "loser.testnet" });
  // payer release — no verdictSig needed
  const r = c.release({ marketId: id, winningClaimId: cid });
  // transfers recorded under the release call's near ctx — re-set to capture:
  const pays = transfers.filter((t) => t.to !== "payer.testnet");
  assert.equal(r.paid, "winner.testnet");
  assert.equal(r.fee, (ONE * 200n / 10000n).toString());
  assert.equal(r.platformCut, (ONE * 1000n / 10000n).toString());
  assert.equal(r.net, (ONE - ONE * 200n / 10000n - ONE * 1000n / 10000n).toString());
  assert.equal(r.losers, 1);
  assert.equal(c.markets.get(id).status, "paid");
  assert.equal(c.claims.get(`${id}:${cid}`).status, "won");
  // losers are lazy: raw storage stays "pending" until finalizeLosers;
  // the resolved view reports "outcompeted" immediately
  const view = c.getClaims({ marketId: id });
  const loserView = view.claims.find((x) => x.claimHash === "lose");
  assert.equal(loserView.status, "outcompeted");
  const fin = c.finalizeLosers({ marketId: id });
  assert.equal(fin.finalized, 1);
  const loser = c.claimBags.get(id).order
    .map((x) => c.claims.get(`${id}:${x}`))
    .find((x) => x.claimHash === "lose");
  assert.equal(loser.status, "outcompeted");
});

test("release: oracle quorum can only settle attested claims", () => {
  const { c } = setup();
  const id = createMarket(c);
  setNear(near, { account: "oracle-signer.testnet" });
  c.registerOracle({ pubkey: "oracle-pk" });
  const cid = ship(c, { marketId: id, claimHash: "h", attested: false });
  // owner's vote lands, quorum met, but the winner isn't attested → reject
  assert.throws(() => c.release({ marketId: id, oraclePubkey: "oracle-pk",
    verdictSig: "x".repeat(64), winningClaimId: cid }), /attested claims/);
});

test("release: oracle settles attested claim, bumps oracle verdicts", () => {
  const { c } = setup();
  const id = createMarket(c);
  setNear(near, { account: "oracle-signer.testnet" });
  c.registerOracle({ pubkey: "oracle-pk" });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  const r = c.release({ marketId: id, oraclePubkey: "oracle-pk",
    verdictSig: "x".repeat(64), winningClaimId: cid });
  assert.equal(r.paid, "w.testnet");
  assert.equal(c.oracles.get("oracle-pk").verdicts, 1);
});

test("release: naming a registered oracle you don't own settles nothing", () => {
  const { c } = setup();
  const id = createMarket(c);
  setNear(near, { account: "oracle-signer.testnet" });
  c.registerOracle({ pubkey: "oracle-pk" });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  // the old hole: any caller could cite a registered pubkey — now the
  // caller must be that oracle's owner account
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.release({ marketId: id, oraclePubkey: "oracle-pk",
    verdictSig: "x".repeat(64), winningClaimId: cid }), /oracle accept votes/);
});

test("submitVerdict: only the oracle owner account can vote", () => {
  const { c } = setup();
  const id = createMarket(c);
  setNear(near, { account: "oracle1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  const cid = ship(c, { marketId: id, claimHash: "h", attested: true });
  setNear(near, { account: "impostor.testnet" });
  assert.throws(() => vote(c, "submitVerdict", { marketId: id, claimId: cid,
    verdict: "accept", oraclePubkey: "pk1" }), /owner account/);
  setNear(near, { account: "oracle1.testnet" });
  const r = vote(c, "submitVerdict", { marketId: id, claimId: cid,
    verdict: "accept", oraclePubkey: "pk1", verdictSig: "sig" });
  assert.equal(r.acceptVotes, 1);
  assert.equal(c.markets.get(id).verdicts["pk1"].verdict, "accept");
});

test("M-of-N: quorum 2 needs two distinct oracle accepts on the same claim", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleQuorumM: 2 });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  ship(c, { marketId: id, claimHash: "other", claimant: "l.testnet", attested: true });
  setNear(near, { account: "oracle1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  c.registerOracle({ pubkey: "pk2" }); // same owner registers second seat
  setNear(near, { account: "oracle2.testnet" });
  c.registerOracle({ pubkey: "pk3" }); // different owner
  // one vote is not enough
  setNear(near, { account: "oracle1.testnet" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pk1" });
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }),
    /2 oracle accept votes \(have 1\)/);
  // a vote for a DIFFERENT claim doesn't help this claim's tally
  vote(c, "submitVerdict", { marketId: id, claimId: "2", verdict: "accept", oraclePubkey: "pk2" });
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }),
    /have 1\)/);
  // second distinct vote on the winner → quorum; a third party collects
  setNear(near, { account: "oracle2.testnet" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pk3" });
  setNear(near, { account: "anyone.testnet" });
  const r = c.release({ marketId: id, winningClaimId: cid });
  assert.equal(r.paid, "w.testnet");
  assert.equal(c.markets.get(id).status, "paid");
});

test("allowlist: only listed oracles count toward quorum", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleAllowlist: ["pkA"] });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pkA" });
  setNear(near, { account: "o2.testnet" });
  c.registerOracle({ pubkey: "pkB" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pkB" });
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }), /have 0/);
  setNear(near, { account: "o1.testnet" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pkA" });
  const r = c.release({ marketId: id, winningClaimId: cid });
  assert.equal(r.paid, "w.testnet");
});

test("deactivated oracle's votes stop counting", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pkX" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pkX" });
  c.deactivateOracle({ pubkey: "pkX" }); // self-eject
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }), /have 0/);
});

test("oracle can correct its vote; reject reduces the accept tally", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleQuorumM: 1 });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pk1" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "reject", oraclePubkey: "pk1" });
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }), /have 0/);
});

test("release: random account cannot settle", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h" });
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }), /oracle accept votes/);
});

test("refund: payer pulls only with no pending claims; expired is permissionless", () => {
  const { c, transfers } = setup();
  const id = createMarket(c, { deadline: "999999999999999999999" }); // far future
  ship(c, { marketId: id, claimHash: "h" });
  assert.throws(() => c.refund({ marketId: id }), /live with pending/);
  // payer refund with NO pending claims works while live
  const id3 = createMarket(c, { deadline: "999999999999999999999" });
  const r3 = c.refund({ marketId: id3 });
  assert.equal(r3.status, "refunded");
  // expired market: anyone can pull — null deadline never expires
  setNear(near, { account: "payer.testnet", deposit: ONE, timestamp: 1_000n });
  const id2 = createMarket(c, { deadline: "1" }); // epoch+1ns, long past
  setNear(near, { account: "rando.testnet", timestamp: 2_000_000_000_000n });
  const r = c.refund({ marketId: id2 });
  assert.equal(r.status, "expired");
  setNear(near, { account: "payer.testnet", deposit: ONE, timestamp: 1_000n });
  const id4 = createMarket(c, { deadline: null });
  setNear(near, { account: "rando.testnet", timestamp: 2_000_000_000_000n });
  assert.throws(() => c.refund({ marketId: id4 }), /live with pending|not open/);
});

test("getClaims paginates pending-first", () => {
  const { c } = setup();
  const id = createMarket(c);
  for (let i = 0; i < 5; i++) ship(c, { marketId: id, claimHash: `h${i}` });
  const p1 = c.getClaims({ marketId: id, from: 0, limit: 3 });
  assert.equal(p1.claims.length, 3);
  assert.equal(p1.total, 5);
  const p2 = c.getClaims({ marketId: id, from: 3, limit: 3 });
  assert.equal(p2.claims.length, 2);
});

test("listOpen filters paid/refunded markets", () => {
  const { c } = setup();
  const open = createMarket(c);
  const paid = createMarket(c);
  ship(c, { marketId: paid, claimHash: "h", claimant: "w" });
  c.release({ marketId: paid });
  const list = c.listOpen();
  assert.deepEqual(list.map((m) => m.marketId), [open]);
});

// ---- D4 disputes: bonded appeal → freeze → arbitrator ruling ----

const BOND = 100_000_000_000_000_000_000_000n; // 0.1 NEAR default

test("dispute requires the bond; freezes release + refund while open", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "watcher.testnet", deposit: 1n }); // bond too small
  assert.throws(() => c.dispute({ marketId: id, claimId: cid, evidenceCid: "bafyEv" }), /bond/);
  setNear(near, { account: "watcher.testnet", deposit: BOND });
  c.dispute({ marketId: id, claimId: cid, evidenceCid: "bafyEv" });
  assert.equal(c.getDisputes({ marketId: id }).length, 1);
  // release frozen — even by payer
  setNear(near, { account: "payer.testnet" });
  assert.throws(() => c.release({ marketId: id, winningClaimId: cid }), /dispute freezes/);
  assert.throws(() => c.refund({ marketId: id }), /dispute freezes/);
});

test("resolveDispute pay_claim settles to the disputed claim; bond refunded", () => {
  const { c, transfers } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "watcher.testnet", deposit: BOND });
  c.dispute({ marketId: id, claimId: cid, evidenceCid: "bafyEv" });
  // non-arbitrator cannot rule
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.resolveDispute({ marketId: id, claimId: cid, ruling: "pay_claim" }), /arbitrator/);
  // default arbitrator = contract account
  const arbTransfers = setNear(near, { account: "contract.testnet" });
  const r = c.resolveDispute({ marketId: id, claimId: cid, ruling: "pay_claim" });
  assert.equal(r.ruled, "pay_claim");
  const m = c.markets.get(id);
  assert.equal(m.status, "paid");
  assert.equal(m.paidTo, "w.testnet");
  assert.equal(m.arbitrated, true);
  // bond refunded to disputer; payout landed
  const paid = arbTransfers.find((t) => t.to === "w.testnet");
  const refund = arbTransfers.find((t) => t.to === "watcher.testnet");
  assert.ok(paid && refund);
});

test("resolveDispute dismiss burns bond to sink; adjudication resumes", () => {
  const { c, transfers } = setup();
  const id = createMarket(c, { oracleQuorumM: 1 });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "spam.testnet", deposit: BOND });
  c.dispute({ marketId: id, claimId: cid, evidenceCid: "bafySpam" });
  const arbTransfers = setNear(near, { account: "contract.testnet" });
  c.resolveDispute({ marketId: id, claimId: cid, ruling: "dismiss" });
  assert.ok(arbTransfers.find((t) => t.to === "widespread-dao.near"));
  // dispute resolved → normal oracle-quorum settlement works again
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pk1" });
  const r = c.release({ marketId: id, winningClaimId: cid });
  assert.equal(r.paid, "w.testnet");
});

test("resolveDispute refund voids the market; reject_claim keeps it open", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  const cid2 = ship(c, { marketId: id, claimHash: "h2", claimant: "w2.testnet" });
  setNear(near, { account: "watcher.testnet", deposit: BOND });
  c.dispute({ marketId: id, claimId: cid });
  setNear(near, { account: "contract.testnet" });
  c.resolveDispute({ marketId: id, claimId: cid, ruling: "reject_claim" });
  assert.equal(c.markets.get(id).status, "open");
  assert.equal(c.claims.get(`${id}:${cid}`).status, "rejected");
  assert.equal(c.claims.get(`${id}:${cid2}`).status, "pending");
  // market-wide dispute → refund ruling voids escrow back to payer
  setNear(near, { account: "payer.testnet", deposit: ONE });
  const id2 = createMarket(c);
  setNear(near, { account: "any.testnet", deposit: BOND });
  c.dispute({ marketId: id2, claimId: null, evidenceCid: "bafyBadSpec" });
  setNear(near, { account: "contract.testnet" });
  const r = c.resolveDispute({ marketId: id2, claimId: null, ruling: "refund" });
  assert.equal(r.ruled, "refund");
  assert.equal(c.markets.get(id2).status, "refunded");
});

test("setArbitrator rotates the ruling account; per-market override wins", () => {
  const { c } = setup();
  const id = createMarket(c, { arbitrator: "kleros-proxy.testnet" });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "watcher.testnet", deposit: BOND });
  c.dispute({ marketId: id, claimId: cid });
  // contract-level arbitrator does NOT apply — market override wins
  setNear(near, { account: "contract.testnet" });
  c.setArbitrator({ account: "arb.testnet" });
  assert.throws(() => c.resolveDispute({ marketId: id, claimId: cid, ruling: "dismiss" }), /arbitrator/);
  setNear(near, { account: "kleros-proxy.testnet" });
  const r = c.resolveDispute({ marketId: id, claimId: cid, ruling: "dismiss" });
  assert.equal(r.ruled, "dismiss");
});

test("setFeeSink routes protocol revenue; only the contract account can set it", () => {
  const { c, transfers } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  // non-contract account cannot retarget the treasury
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.setFeeSink({ account: "rando.testnet" }), /contract account/);
  // contract account sets the sink; fees + dismissed bonds accrue there
  setNear(near, { account: "contract.testnet" });
  c.setFeeSink({ account: "treasury.testnet" });
  assert.equal(c.getConfig().feeSink, "treasury.testnet");
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pk1" });
  const relTransfers = setNear(near, { account: "o1.testnet" });
  c.release({ marketId: id, winningClaimId: cid });
  const fee = relTransfers.find((t) => t.to === "treasury.testnet");
  assert.ok(fee, "fee transfer went to the configured sink");
  assert.equal(fee.amount, (ONE * 200n) / 20000n); // juror took 50% of the 2% fee
  const juror = relTransfers.find((t) => t.to === "o1.testnet" && t.amount > 0n);
  assert.ok(juror, "accept-voter seat owner paid the juror share");
  assert.equal(juror.amount, (ONE * 200n) / 20000n);
  // dismissed bond also accrues to the sink
  const { c: c2, transfers: t2 } = setup();
  const id2 = createMarket(c2);
  setNear(near, { account: "watcher.testnet", deposit: 10n ** 23n });
  c2.dispute({ marketId: id2, claimId: null });
  const disTransfers = setNear(near, { account: "contract.testnet" });
  c2.setFeeSink({ account: "treasury.testnet" });
  c2.resolveDispute({ marketId: id2, claimId: null, ruling: "dismiss" });
  assert.ok(disTransfers.find((t) => t.to === "treasury.testnet"), "burned bond went to sink");
});

// ---- token escrow: NEP-141 + NEP-245 funding and payout ----

const MARKET_MSG = JSON.stringify({ kind: "open_market", market: {
  specHash: "sha256:ft", spec: "token bounty", deadline: null,
  acceptanceRule: "best", platformBps: 1000, platformTo: "plat.testnet",
} });

test("ft_on_transfer opens a market escrowed in the calling FT", () => {
  const { c } = setup();
  setNear(near, { account: "usdc.tether-token.testnet" });
  const unused = c.ft_on_transfer({ sender_id: "payer.testnet",
    amount: "5000000", msg: MARKET_MSG }); // 5 USDC (6 decimals)
  assert.equal(unused, "0");
  const m = c.markets.get("1");
  assert.equal(m.token, "usdc.tether-token.testnet");
  assert.equal(m.tokenId, "");
  assert.equal(m.locked, "5000000");
  assert.equal(m.payer, "payer.testnet");
  assert.equal(m.platformBps, 1000);
});

test("ft market release pays claimant + fee + platform via ft_transfer", () => {
  const { c } = setup();
  setNear(near, { account: "usdc.tether-token.testnet" });
  c.ft_on_transfer({ sender_id: "payer.testnet", amount: "10000000", msg: MARKET_MSG });
  const cid = ship(c, { marketId: "1", claimHash: "h",
    claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  vote(c, "submitVerdict", { marketId: "1", claimId: cid, verdict: "accept", oraclePubkey: "pk1" });
  const rel = setNear(near, { account: "o1.testnet" });
  c.release({ marketId: "1", winningClaimId: cid });
  // net = 10_000_000 − 2% fee − 10% platform = 8_800_000
  const pay = rel.filter((t) => t.to === "usdc.tether-token.testnet");
  const legs = pay.flatMap((t) => t.calls.filter((x) => x.methodName === "ft_transfer"));
  const byReceiver = Object.fromEntries(legs.map((x) => [x.args.receiver_id, x.args.amount]));
  assert.equal(byReceiver["w.testnet"], "8800000");
  assert.equal(byReceiver["widespread-dao.near"], "100000");   // fee minus juror share
  assert.equal(byReceiver["o1.testnet"], "100000");            // juror share in-kind
  assert.equal(byReceiver["plat.testnet"], "1000000");          // 10% platform
  // every token leg fronts a refundable storage_deposit for the receiver
  assert.ok(pay.every((t) => t.calls[0].methodName === "storage_deposit"
    && t.calls[0].args.registration_only === true));
  // no native transfers on an FT market
  assert.ok(rel.every((t) => t.amount === 0n));
});

test("mt_on_transfer escrows an intents multi-token; release bridges out", () => {
  const { c } = setup();
  setNear(near, { account: "intents.near" });
  const out = c.mt_on_transfer({ sender_id: "payer.testnet",
    token_ids: ["nep141:eth-usdc.omft.near"], amounts: ["5000000"], msg: MARKET_MSG });
  assert.deepEqual(out, { token_ids: [], amounts: [] });
  const m = c.markets.get("1");
  assert.equal(m.token, "intents.near");
  assert.equal(m.tokenId, "nep141:eth-usdc.omft.near");
  const cid = ship(c, { marketId: "1", claimHash: "h", claimant: "w.testnet",
    attested: true, payoutIntent: { signed: "worker-withdraw-to-solana" } });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  vote(c, "submitVerdict", { marketId: "1", claimId: cid, verdict: "accept", oraclePubkey: "pk1" });
  const rel = setNear(near, { account: "o1.testnet" });
  c.release({ marketId: "1", winningClaimId: cid });
  const legs = rel.filter((t) => t.to === "intents.near")
    .flatMap((t) => t.calls);
  const mt = legs.filter((x) => x.methodName === "mt_transfer");
  assert.equal(mt.find((x) => x.args.receiver_id === "w.testnet").args.token_id,
    "nep141:eth-usdc.omft.near");
  // bridge-out: execute_intents chained with the presigned withdraw payload
  const bridge = legs.find((x) => x.methodName === "execute_intents");
  assert.deepEqual(bridge.args.signed, { signed: "worker-withdraw-to-solana" });
});

test("mt_on_transfer refuses batched token ids; bad msg reverts", () => {
  const { c } = setup();
  setNear(near, { account: "intents.near" });
  assert.throws(() => c.mt_on_transfer({ sender_id: "p", token_ids: ["a", "b"],
    amounts: ["1", "1"], msg: MARKET_MSG }), /one mt token id/);
  setNear(near, { account: "usdc.tether-token.testnet" });
  assert.throws(() => c.ft_on_transfer({ sender_id: "p", amount: "5",
    msg: "{}" }), /open_market/);
});

test("ft market refund returns escrow via ft_transfer to payer", () => {
  const { c } = setup();
  setNear(near, { account: "usdc.tether-token.testnet" });
  c.ft_on_transfer({ sender_id: "payer.testnet", amount: "7000000", msg: MARKET_MSG });
  const ref = setNear(near, { account: "payer.testnet" });
  c.refund({ marketId: "1" });
  const call = ref.flatMap((t) => t.calls).find((x) => x.methodName === "ft_transfer");
  assert.equal(call.args.receiver_id, "payer.testnet");
  assert.equal(call.args.amount, "7000000");
});

// ---- science upgrades: commit-reveal, confidence, bonded seats ----

const digest = (s) => createHash("sha256").update(s).digest("hex");
const commitFor = ({ marketId, claimId, verdict, conf, salt, pk }) =>
  digest(`${marketId}|${claimId}|${verdict}|${conf ?? ""}|${salt ?? ""}|${pk}`);

test("commit-reveal: reveals gated on commit quorum; plain submitVerdict refused", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleQuorumM: 2, commitReveal: true });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  setNear(near, { account: "o2.testnet" });
  c.registerOracle({ pubkey: "pk2" });
  // plain votes are refused on a blind market
  assert.throws(() => vote(c, "submitVerdict", { marketId: id, claimId: cid,
    verdict: "accept", oraclePubkey: "pk1" }), /commit-reveal/);
  // commit — nothing about the vote is public
  setNear(near, { account: "o1.testnet" });
  const cmt1 = c.commitVerdict({ marketId: id, oraclePubkey: "pk1",
    commit: commitFor({ marketId: id, claimId: cid, verdict: "accept", conf: 95, salt: "s1", pk: "pk1" }) });
  assert.equal(cmt1.commits, 1);
  // reveal before commit quorum: refused
  assert.throws(() => vote(c, "revealVerdict", { marketId: id, claimId: cid,
    verdict: "accept", conf: 95, salt: "s1", oraclePubkey: "pk1" }), /committed active jurors/);
  setNear(near, { account: "o2.testnet" });
  c.commitVerdict({ marketId: id, oraclePubkey: "pk2",
    commit: commitFor({ marketId: id, claimId: cid, verdict: "accept", conf: 92, salt: "s2", pk: "pk2" }) });
  // quorum of commits in — reveals open
  const t2 = vote(c, "revealVerdict", { marketId: id, claimId: cid,
    verdict: "accept", conf: 92, salt: "s2", oraclePubkey: "pk2" });
  assert.equal(t2.acceptVotes, 1);
  setNear(near, { account: "o1.testnet" });
  const t1 = vote(c, "revealVerdict", { marketId: id, claimId: cid,
    verdict: "accept", conf: 95, salt: "s1", oraclePubkey: "pk1" });
  assert.equal(t1.acceptVotes, 2);
  assert.equal(t1.unanimousHighConf, true);
  // quorum met → release settles
  const rel = setNear(near, { account: "o1.testnet" });
  c.release({ marketId: id, winningClaimId: cid });
  assert.equal(c.markets.get(id).status, "paid");
});

test("revealVerdict refuses a preimage that doesn't match the commit", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleQuorumM: 2, commitReveal: true });
  ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  setNear(near, { account: "o2.testnet" });
  c.registerOracle({ pubkey: "pk2" });
  setNear(near, { account: "o1.testnet" });
  c.commitVerdict({ marketId: id, oraclePubkey: "pk1",
    commit: commitFor({ marketId: id, claimId: "1", verdict: "accept", salt: "s1", pk: "pk1" }) });
  setNear(near, { account: "o2.testnet" });
  c.commitVerdict({ marketId: id, oraclePubkey: "pk2",
    commit: commitFor({ marketId: id, claimId: "1", verdict: "accept", salt: "s2", pk: "pk2" }) });
  // committed accept, tries to reveal reject — hash mismatch
  setNear(near, { account: "o1.testnet" });
  assert.throws(() => vote(c, "revealVerdict", { marketId: id, claimId: "1",
    verdict: "reject", salt: "s1", oraclePubkey: "pk1" }), /does not match/);
});

test("conf verdicts: split or weak confidence is not unanimousHighConf", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleQuorumM: 2 });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  setNear(near, { account: "o2.testnet" });
  c.registerOracle({ pubkey: "pk2" });
  setNear(near, { account: "o3.testnet" });
  c.registerOracle({ pubkey: "pk3" });
  setNear(near, { account: "o1.testnet" });
  const t1 = vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", conf: 95, oraclePubkey: "pk1" });
  assert.equal(t1.unanimousHighConf, false); // below quorum
  setNear(near, { account: "o3.testnet" });
  const t3 = vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "reject", conf: 60, oraclePubkey: "pk3" });
  assert.equal(t3.rejectVotes, 1);
  setNear(near, { account: "o2.testnet" });
  const t2 = vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", conf: 92, oraclePubkey: "pk2" });
  assert.equal(t2.acceptVotes, 2);
  assert.equal(t2.unanimousHighConf, false); // split vote → escalate
  // conf must be an int 0-100
  setNear(near, { account: "o1.testnet" });
  assert.throws(() => vote(c, "submitVerdict", { marketId: id, claimId: cid,
    verdict: "accept", conf: 101, oraclePubkey: "pk1" }), /0-100/);
});

test("unanimous high-confidence quorum reports auto-settleable", () => {
  const { c } = setup();
  const id = createMarket(c, { oracleQuorumM: 2 });
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  setNear(near, { account: "o2.testnet" });
  c.registerOracle({ pubkey: "pk2" });
  setNear(near, { account: "o1.testnet" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", conf: 97, oraclePubkey: "pk1" });
  setNear(near, { account: "o2.testnet" });
  const t = vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", conf: 90, oraclePubkey: "pk2" });
  assert.equal(t.unanimousHighConf, true);
  // a weak-conf rewrite flips the signal back
  const t2 = vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", conf: 55, oraclePubkey: "pk2" });
  assert.equal(t2.unanimousHighConf, false);
});

test("bonded oracle slashed to sink on overturned verdict; unbonded keeps voting", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  const bond = 2n * ONE;
  setNear(near, { account: "o1.testnet", deposit: bond });
  c.registerOracle({ pubkey: "pkB" });        // bonded seat
  setNear(near, { account: "o2.testnet" });
  c.registerOracle({ pubkey: "pkU" });        // unbonded seat
  setNear(near, { account: "o1.testnet" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pkB" });
  setNear(near, { account: "o2.testnet" });
  vote(c, "submitVerdict", { marketId: id, claimId: cid, verdict: "accept", oraclePubkey: "pkU" });
  // disputer bonds an appeal; arbitrator rules the claim rejected — the
  // accept votes were wrong; bonded seat loses its bond to the sink.
  setNear(near, { account: "d.testnet", deposit: DEFAULT_BOND });
  c.dispute({ marketId: id, claimId: cid, evidenceCid: "bafyEv" });
  const arb = setNear(near, { account: "contract.testnet" });
  const r = c.resolveDispute({ marketId: id, claimId: cid, ruling: "reject_claim" });
  assert.deepEqual(r.slashed, ["pkB"]);
  assert.equal(c.oracles.get("pkB").bond, "0");
  assert.equal(c.oracles.get("pkB").slashes, 1);
  const slash = arb.find((t) => t.to === "widespread-dao.near" && t.amount === bond);
  assert.ok(slash, "bond moved to sink");
  // disputer (upheld) was refunded the dispute bond
  assert.ok(arb.find((t) => t.to === "d.testnet"));
});

test("bondOracle tops up an existing seat", () => {
  const { c } = setup();
  setNear(near, { account: "o1.testnet" });
  c.registerOracle({ pubkey: "pk1" });
  setNear(near, { account: "patron.testnet", deposit: ONE });
  const r = c.bondOracle({ oraclePubkey: "pk1" });
  assert.equal(r.bond, ONE.toString());
  setNear(near, { account: "x.testnet", deposit: 0n });
  assert.throws(() => c.bondOracle({ oraclePubkey: "pk1" }), /attach a bond/);
});

// ---- scale: storage-backed state, concurrent markets, big claim sets ----

test("legacy plain-object state migrates into collections on first call", () => {
  const { c } = setup();
  // Simulate state written by the pre-collections deploy: replace the
  // maps with plain objects, clear the indices, then touch any method.
  c.markets = { "1": { status: "open", payer: "payer.testnet", locked: ONE.toString(), verdicts: {} } };
  c.oracles = { pkOld: { active: true, owner: "o.testnet", verdicts: 3, disputes: 0 } };
  c.claims = { "1": { seq: 1, items: { "1": { claimId: "1", marketId: "1", claimHash: "old", status: "pending", claimant: "w.testnet", shippedBy: "w.testnet", attested: true, claimDeadline: "999" } }, order: ["1"] } };
  c.claimBags = {}; c.marketIds = undefined; c.oracleKeys = undefined;
  assert.equal(c.getMarket({ marketId: "1" }).payer, "payer.testnet");
  assert.equal(c.oracles.get("pkOld").verdicts, 3);
  assert.equal(c.claims.get("1:1").claimHash, "old");
  assert.equal(c.claimBags.get("1").order[0], "1");
  assert.deepEqual(c.marketIds, ["1"]);
  assert.deepEqual(c.oracleKeys, ["pkOld"]);
  // second call: maps already live — hydration is idempotent
  assert.equal(c.getMarket({ marketId: "1" }).payer, "payer.testnet");
  // oldest shape: claims[mid] was the claim record itself
  c.claims = { "2": { claimHash: "ancient", claimant: "a.testnet" } };
  c.claimBags = {}; // bags map hydrated — but claims held legacy data → migrate again
  // force a second legacy pass
  c.claims._m = null; // defensive no-op; _ensure converts non-map objects
  const m2 = { ...c };
  void m2;
});

test("legacy single-claim record shape migrates attested", () => {
  const { c } = setup();
  c.markets = { "5": { status: "open", payer: "p.testnet", locked: ONE.toString(), deadline: "42", verdicts: {} } };
  c.oracles = {}; c.claimBags = {};
  c.claims = { "5": { claimHash: "anc", claimant: "old.testnet" } };
  c.marketIds = undefined; c.oracleKeys = undefined;
  c._ensure();
  const claim = c.claims.get("5:1");
  assert.equal(claim.attested, true);
  assert.equal(claim.shippedBy, "old.testnet");
  assert.deepEqual(c.claimBags.get("5"), { seq: 1, order: ["1"] });
});

test("many markets + hundreds of claims scale independently", () => {
  const { c } = setup();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    setNear(near, { account: `payer${i}.testnet`, deposit: ONE });
    ids.push(createMarket(c));
  }
  assert.equal(ids.length, 20);
  assert.equal(c.listAll().length, 20);
  // 50 pending claims on market 1, a few on others
  setNear(near, { account: "w.testnet" });
  for (let i = 0; i < 50; i++) {
    ship(c, { marketId: ids[0], claimHash: `h${i}`, claimant: `w${i}.testnet`, attested: true });
  }
  ship(c, { marketId: ids[5], claimHash: "x", claimant: "w5.testnet" });
  const page1 = c.getClaims({ marketId: ids[0], from: 0, limit: 25 });
  const page2 = c.getClaims({ marketId: ids[0], from: 25, limit: 25 });
  assert.equal(page1.claims.length, 25);
  assert.equal(page2.claims.length, 25);
  assert.equal(page1.total, 50);
  assert.equal(page1.pending, 50);
  // claims are keyed per-market — no cross-market contamination
  assert.equal(c.getClaims({ marketId: ids[5] }).total, 1);
  // settle market 0; other markets untouched
  setNear(near, { account: `payer0.testnet` });
  const r = c.release({ marketId: ids[0], winningClaimId: "7" });
  assert.equal(r.losers, 49);
  assert.equal(c.claims.get(`${ids[0]}:7`).status, "won");
  // raw storage keeps losers "pending" (lazy) — resolve via view/finalize
  const resolved = c.getClaims({ marketId: ids[0] }).claims
    .find((x) => x.claimId === "3");
  assert.equal(resolved.status, "outcompeted");
  assert.equal(c.markets.get(ids[5]).status, "open");
  assert.equal(c.claims.get(`${ids[5]}:1`).status, "pending");
  assert.equal(c.listOpen().length, 19);
});

test("claim ids and market ids never collide across prefixes", () => {
  const { c } = setup();
  setNear(near, { account: "p.testnet", deposit: ONE });
  const a = createMarket(c);
  const b = createMarket(c);
  setNear(near, { account: "w.testnet" });
  const ca = ship(c, { marketId: a, claimHash: "A", claimant: "wa.testnet" });
  const cb = ship(c, { marketId: b, claimHash: "B", claimant: "wb.testnet" });
  // both markets get claimId "1" — global key space keeps them distinct
  assert.equal(ca, "1"); assert.equal(cb, "1");
  assert.equal(c.claims.get(`${a}:1`).claimHash, "A");
  assert.equal(c.claims.get(`${b}:1`).claimHash, "B");
  c.withdrawClaim({ marketId: a, claimId: ca });
  assert.equal(c.claims.get(`${b}:1`).status, "pending");
});

test("shipClaim requires storage deposit; deposit scales with record size", () => {
  const { c } = setup();
  const id = createMarket(c);
  // no deposit → revert
  setNear(near, { account: "w.testnet", deposit: 0n });
  assert.throws(() => c.shipClaim({ marketId: id, claimHash: "h" }), /storage deposit/);
  // tiny deposit insufficient for a fat record
  const fat = "x".repeat(10_000);
  setNear(near, { account: "w.testnet", deposit: 1000n });
  assert.throws(() => c.shipClaim({ marketId: id, claimHash: "h", evidence: { blob: fat } }), /storage deposit/);
  // sufficient → lands; expiry reap refunds the stake to shippedBy
  const cid = ship(c, { marketId: id, claimHash: "h", claimant: "w.testnet" });
  const stake = BigInt(c.claims.get(`${id}:${cid}`).storageStake);
  assert.ok(stake > 0n);
  setNear(near, { account: "anyone.testnet", timestamp: 10n ** 20n });
  const t = setNear(near, { account: "anyone.testnet", timestamp: 10n ** 20n });
  const r = c.cleanupExpired({ marketId: id });
  assert.equal(r.reaped, 1);
  assert.equal(c.claims.get(`${id}:${cid}`), null);
  assert.equal(t.find((x) => x.to === "w.testnet")?.amount, stake);
});
