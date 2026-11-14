// contract.src.js — widespread permissionless market on NEAR (near-sdk-js 2.x).
//
// SOURCE OF TRUTH: near-sdk-js build overwrites contract.js — edit THIS file,
// rebuild via the market build pipeline, deploy build/contract.wasm.
//
// The loop: payer locks NEAR in createMarket → agents ship signed dg-ship-1
// claims (UNBOUNDED — no cap on submissions) → a verdict names the winning
// claim → escrow releases to the best VERIFIED work, not the first past the
// post. Losers are recorded with public scores — strong losing work still
// builds reputation. 2% to a DAO sink, no platform cut.
//
// Claims are free for claimants: contract state bytes are absorbed by the
// contract account (~300B/claim), reclaimed when claims expire and are
// batch-deleted. Spam is deterred by consequences, not tolls: bridge-side
// attestation (real forge submissions only), stage-1 evidence recompute,
// forge-native identity, and verdict competition.
//
// Oracles register themselves — permissionless adjudication: the bridge
// is the reference implementation, but any payer can pick their own
// oracle (a human key, an AI endpoint, an OutLayer TDX worker, or NEAR AI
// Cloud's provider_tee signed inference).
//
// Trust model: an oracle's authority on-chain is its OWNER ACCOUNT — the
// account that called registerOracle — not a signature string. Oracles
// vote via submitVerdict() from that account; release() pays only when
// `oracleQuorumM` distinct active oracles accept the SAME claim (or the
// payer signs). One key can no longer move funds alone, and naming a
// registered pubkey without owning its account does nothing. The
// off-chain ed25519 verdictSig + TEE attestation stay attached as
// evidence/reputation, but settlement authority is on-chain tally.
//
// Payer-sig release is fully on-chain (signer == payer). Escrow +
// timeout are on-chain facts. Quorum default 1 keeps pre-upgrade markets
// (single reference oracle) settleable.

import { NearBindgen, near, call, view, assert, encode, LookupMap } from "near-sdk-js";

/** LazyMap: LookupMap with a serialized overlay for legacy state. Reads
 *  check storage first, then the overlay — so a pre-collections deploy
 *  upgrades with ZERO writes: entries drain into real storage the first
 *  time a call writes them (set/remove evict the overlay copy). This is
 *  what lets @view methods serve migrated state without storage_write. */
class LazyMap extends LookupMap {
  constructor(keyPrefix, overlay = {}) {
    super(keyPrefix);
    this._overlay = overlay;
  }
  get(key) {
    const v = super.get(key);
    return v ?? this._overlay[key] ?? null;
  }
  set(key, value) {
    delete this._overlay[key];
    super.set(key, value);
  }
  remove(key) {
    delete this._overlay[key];
    super.remove(key);
  }
  containsKey(key) {
    return super.containsKey(key) || key in this._overlay;
  }
}

const OPEN = "open";
const PAID = "paid";
const REFUNDED = "refunded";
const EXPIRED = "expired";
const DAO_SINK = "widespread-dao.near"; // default sink — overridable via setFeeSink
const FEE_BPS = 200n; // 2%
const DEFAULT_CLAIM_TTL_NS = 7n * 24n * 60n * 60n * 1_000_000_000n; // 7 days
const CLAIM_PAGE = 50;
const DEFAULT_QUORUM_M = 1;
const MAX_QUORUM_M = 15;
// Disputes: a bonded appeal freezes release until the arbitrator rules.
// The bond deters spam — upheld disputes refund it, dismissed ones burn
// it to the DAO sink. 0.1 NEAR keeps testnet cheap; production markets
// can raise it per-market via disputeBondYocto.
const DEFAULT_DISPUTE_BOND = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
// Storage registration fronted for token payouts — refunded by the token
// contract when the receiver is already registered (registration_only).
const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
// Claim storage staking: NEAR charges ~1e19 yocto/byte. shipClaim callers
// deposit bytes×rate×margin; it's returned when the claim leaves storage
// (withdrawn / expired / refunded-market). Won/lost claim records are the
// permanent public scoreboard — their stake stays with the contract.
const CLAIM_STORAGE_BPS = 120n;      // 1.2× headroom over the raw rate
const YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;
// First verdict per seat per market adds a key inside the market record —
// a small flat stake covers those bytes for life. Corrections are free.
const VERDICT_STAKE_YOCTO = 2_500_000_000_000_000_000_000n; // 0.0025 NEAR
// Juror fee-share: accept-voters on the winning claim split this share of
// the protocol fee — jury work is funded out of revenue, never the
// worker's 100% or extra taxes on funders.
const JUROR_SHARE_BPS = 5000n;       // 50% of the fee → 1% of escrow

@NearBindgen({})
export class WidespreadMarket {
  constructor() {
    // Storage-backed collections: per-transaction cost is O(touched
    // entries), not O(total state) — markets, claims-per-market, and
    // oracle seats all scale unbounded without starving settlement.
    // These MUST stay plain placeholders here, never `new LookupMap` —
    // near-sdk-js _reconstruct calls LookupMap.reconstruct(stored[field])
    // for collection-typed fields, which crashes on state written by a
    // pre-collections deploy (and on fields the old state lacks). _ensure
    // does the real wrap-or-migrate at the top of every entry point.
    this.markets = {};   // LookupMap("mk"): marketId -> market record
    this.claims = {};    // LookupMap("cl"): `${marketId}:${claimId}` -> claim
    this.claimBags = {}; // LookupMap("cb"): marketId -> { seq, order }
    this.oracles = {};   // LookupMap("or"): pubkey -> seat record
    // Enumeration indices stay in plain state — just id strings.
    this.marketIds = [];
    this.oracleKeys = [];
    // NB: top-level instance fields must never be null — _reconstruct
    // calls .constructor on each. "" = unset → contract account rules.
    this.arbitrator = "";
    // "" = default DAO_SINK — set to the treasury account via setFeeSink
    // so the 2% protocol fee + dismissed bonds + platform cuts actually
    // accrue somewhere controlled (the hardcoded mainnet sink does not
    // exist on other networks).
    this.feeSink = "";
    this.nextId = 1;
  }

  _sink() { return this.feeSink || DAO_SINK; }

  /** State-layout migration + collection hydration, idempotent.
   *  Called first in every entry point. Three cases:
   *   - fresh maps (real LookupMap instances) → no-op
   *   - maps hydrated from serialized state ({keyPrefix} plain object,
   *     entries already in storage) → re-wrap the accessor
   *   - legacy plain-object state (pre-collections deploy) → copy all
   *     entries into the collections once, then rebuild the id arrays. */
  _ensure() {
    // Wrap-or-overlay one field — never writes storage, so @view calls
    // can serve unmigrated state. Returns the legacy overlay when the
    // field held plain data, null when it was already a map.
    const hydra = (field, prefix) => {
      const v = this[field];
      if (typeof v?.get === "function") return null;              // live
      if (v && "keyPrefix" in v) {                                // serialized
        this[field] = new LazyMap(v.keyPrefix, v._overlay ?? {});
        return null;
      }
      const overlay = v && typeof v === "object" ? { ...v } : {};
      this[field] = new LazyMap(prefix, overlay);
      return overlay;
    };
    const lm = hydra("markets", "mk");
    const lc = hydra("claims", "cl");
    const lb = hydra("claimBags", "cb");
    const lo = hydra("oracles", "or");
    if (lm) this.marketIds = Object.keys(lm);   // legacy state lacked ids
    if (lo) this.oracleKeys = Object.keys(lo);
    if (lb) {
      // pre-collections state had no claimBags field; only ever {} here
    }
    if (lc) {
      // legacy nested bag {seq, items, order} → flatten to per-claim
      // keys; the raw mid→bag overlay entries get replaced below
      for (const [mid, bag] of Object.entries(lc)) {
        delete this.claims._overlay[mid];
        if (bag?.items) {
          this.claimBags._overlay[mid] =
            { seq: bag.seq ?? 0, order: bag.order ?? [] };
          for (const [cid, c] of Object.entries(bag.items)) {
            this.claims._overlay[`${mid}:${cid}`] = c;
          }
        } else if (bag?.claimHash !== undefined) {
          // oldest shape: claims[mid] was the claim record itself —
          // bridge-validated, so it migrates attested and settleable
          this.claimBags._overlay[mid] = { seq: 1, order: ["1"] };
          this.claims._overlay[`${mid}:1`] = {
            ...bag, claimId: "1", marketId: mid,
            status: bag.status ?? "pending", shippedBy: bag.claimant,
            attested: true, claimDeadline: bag.claimDeadline ?? "0" };
        } else {
          this.claims._overlay[mid] = bag;
        }
      }
    }
    this.marketIds ??= [];
    this.oracleKeys ??= [];
  }

  _m(marketId) { return this.markets.get(marketId); }
  _claim(marketId, claimId) { return this.claims.get(`${marketId}:${claimId}`); }
  _saveClaim(c) { this.claims.set(`${c.marketId}:${c.claimId}`, c); }

  /** Treasury routing: protocol fee, dismissed dispute bonds, and the
   *  default platformTo all accrue to _sink(). Only the contract
   *  account itself may retarget it — later a DAO multisig. */
  @call({})
  setFeeSink({ account }) {
    assert(near.predecessorAccountId() === near.currentAccountId(),
      "only the contract account can set the fee sink");
    assert(account && account.includes("."), "bad account");
    this.feeSink = account;
    return { feeSink: this.feeSink };
  }

  @view({})
  getConfig() {
    return { feeBps: FEE_BPS.toString(), feeSink: this._sink(),
             arbitrator: this.arbitrator, nextId: this.nextId };
  }

  // ---- payer: lock the bounty ----
  //
  // Three funding rails:
  //   native NEAR — createMarket with attached deposit.
  //   NEP-141 FT  — ft_transfer_call on the token contract with
  //                 msg {kind:"open_market", market:{...}} → ft_on_transfer.
  //   NEP-245 mt  — mt_transfer_call on an intents-style multi-token
  //                 contract (omni-assets) → mt_on_transfer. The escrow
  //                 holds the token natively; release pays out via
  //                 mt_transfer and, when the claim ships a presigned
  //                 payoutIntent, chains execute_intents so settlement
  //                 bridges to the worker's home chain in the same tx.
  // Escrow, fees, and platform cuts are denominated in m.token; all are
  // paid through _payout so revenue accrues to the sink in-kind.
  // Dispute bonds stay native NEAR — anti-spam collateral, not bounty.

  @call({ payableFunction: true })
  createMarket({ specHash, spec, deadline, acceptanceRule, payToHat, claimTtlNs, acceptanceHash, platformBps, platformTo, oracleQuorumM, oracleAllowlist, arbitrator, disputeBondYocto, commitReveal }) {
    this._ensure();
    const payer = near.predecessorAccountId();
    const attached = near.attachedDeposit();
    assert(attached > 0n, "market must be funded — attach the bounty");
    return this._openMarket(payer, attached, "", "", {
      specHash, spec, deadline, acceptanceRule, payToHat, claimTtlNs,
      acceptanceHash, platformBps, platformTo, oracleQuorumM,
      oracleAllowlist, arbitrator, disputeBondYocto, commitReveal,
    });
  }

  /** NEP-141 receiver: funding via ft_transfer_call on the token contract.
   *  predecessor = the FT contract = the escrowed token. */
  @call({})
  ft_on_transfer({ sender_id, amount, msg }) {
    this._ensure();
    const parsed = JSON.parse(msg);
    assert(parsed?.kind === "open_market" && parsed.market,
      "msg must be {kind:'open_market',market:{...}}");
    this._openMarket(sender_id, BigInt(amount),
      near.predecessorAccountId(), "", parsed.market);
    return "0"; // whole transfer consumed
  }

  /** NEP-245 receiver: funding via mt_transfer_call on an intents-style
   *  multi-token contract. Escrow holds token_ids[0] under this account;
   *  payout bridges out via the standard intents withdraw flow. */
  @call({})
  mt_on_transfer({ sender_id, token_ids, amounts, msg }) {
    this._ensure();
    assert(Array.isArray(token_ids) && token_ids.length === 1 &&
           Array.isArray(amounts) && amounts.length === 1,
      "one mt token id per market — batch funding refused");
    const parsed = JSON.parse(msg);
    assert(parsed?.kind === "open_market" && parsed.market,
      "msg must be {kind:'open_market',market:{...}}");
    this._openMarket(sender_id, BigInt(amounts[0]),
      near.predecessorAccountId(), token_ids[0], parsed.market);
    return { token_ids: [], amounts: [] }; // all consumed
  }

  _openMarket(payer, locked, token, tokenId,
              { specHash, spec, deadline, acceptanceRule, payToHat, claimTtlNs, acceptanceHash, platformBps, platformTo, oracleQuorumM, oracleAllowlist, arbitrator, disputeBondYocto, commitReveal }) {
    assert(locked > 0n, "market must be funded — attach the bounty");
    assert((platformBps ?? 0) <= 5000, "platformBps above 50% refused");
    assert((oracleQuorumM ?? DEFAULT_QUORUM_M) >= 1 && (oracleQuorumM ?? 1) <= MAX_QUORUM_M,
      "oracleQuorumM out of range");
    const marketId = String(this.nextId++);
    this.marketIds.push(marketId);
    this.markets.set(marketId, {
      marketId, payer, specHash, spec,
      locked: locked.toString(), deadline, acceptanceRule,
      // Escrowed asset: "" = native NEAR; otherwise the NEP-141/NEP-245
      // contract id (predecessor of *_on_transfer). tokenId names the
      // sub-asset for multi-token escrow (nep245 token id); "" for
      // single-token FTs and native.
      token, tokenId,
      // hidden_tests acceptanceRule: payer commits a hash of hidden checks
      // at funding; stage-1 recompute enforces them before oracle.
      acceptanceHash: acceptanceHash ?? null,
      claimTtlNs: claimTtlNs ?? DEFAULT_CLAIM_TTL_NS.toString(),
      // Intentional Hats binding: when set, release records the earning
      // hat so the bridge can route settlement through the hat's intents
      // leg (foreign address / Poidh claim) instead of only NEAR.
      payToHat: payToHat ?? null,
      // Mirror-market markup: platformBps of `locked` is skimmed at release
      // to platformTo (default DAO sink) — how third-party bounties listed
      // through us earn their spread. 0 = plain market, unchanged.
      platformBps: platformBps ?? 0,
      platformTo: platformTo ?? null,
      // Jury config: oracleQuorumM distinct ACTIVE oracles must vote accept
      // on the same claim to release. oracleAllowlist (optional) restricts
      // which registered oracle pubkeys count — the funder's sovereign
      // jury selection. verdicts: oraclePubkey -> {claimId, verdict, sig}.
      oracleQuorumM: oracleQuorumM ?? DEFAULT_QUORUM_M,
      oracleAllowlist: oracleAllowlist ?? null,
      verdicts: {},
      // Commit-reveal voting (funder opt-in): jurors post a hash of
      // their verdict before any vote is public — kills bandwagon
      // copying (ERC-8033/Verdikta pattern). commitVerdict() collects
      // commitments; once quorum-many are in, revealVerdict() opens
      // the ballot and the vote counts. Plain submitVerdict is
      // refused on these markets.
      commitReveal: commitReveal === true,
      commits: {},
      // Appeal layer: arbitrator = per-market override or contract default
      // (Kleros proxy later); open disputes freeze release until ruled.
      arbitrator: arbitrator ?? null,
      disputeBondYocto: disputeBondYocto ?? null,
      disputes: {},   // claimId -> {disputer, evidenceCid, bond, ts, status, ruling}
      status: OPEN, createdAt: near.blockTimestamp().toString(),
    });
    this.claimBags.set(marketId, { seq: 0, order: [] });
    return marketId;
  }

  @call({})
  refund({ marketId }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    // deadline may be null (open-ended market) — BigInt(null) throws, so
    // guard explicitly; null means "never expires", not "expired now".
    const expired = m.deadline != null && near.blockTimestamp() > BigInt(m.deadline);
    const noPending = !this._hasPending(marketId);
    // an open dispute freezes refunds too — no pulling funds mid-appeal
    // (expired markets still refund regardless: timeouts are final).
    if (!expired) {
      const open = Object.values(m.disputes ?? {}).filter((d) => d.status === "open");
      assert(!open.length, "open dispute freezes refund");
    }
    // payer can pull unclaimed funds any time; anyone can pull expired —
    // a payer can't hostage a market forever (timeout auto-release).
    assert(
      (near.predecessorAccountId() === m.payer && noPending) || expired,
      "market is live with pending claims"
    );
    m.status = expired ? EXPIRED : REFUNDED;
    this.markets.set(marketId, m);
    this._payout(m, m.payer, BigInt(m.locked));
    return { refunded: m.payer, amount: m.locked, status: m.status };
  }

  // ---- oracle registry (permissionless) ----

  /** Register a jury seat — optionally BONDED. The attached deposit is
   *  held on the seat and slashed to the treasury when an arbitrator
   *  ruling proves the seat's verdict wrong (resolveDispute). Zero
   *  bond = legacy unbonded seat: can vote, can't be slashed, and
   *  carries no skin-in-the-game signal to funders. */
  @call({ payableFunction: true })
  registerOracle({ pubkey }) {
    this._ensure();
    const who = near.predecessorAccountId();
    assert(!this.oracles.get(pubkey), "oracle already registered");
    this.oracleKeys.push(pubkey);
    this.oracles.set(pubkey, { active: true, owner: who, verdicts: 0, disputes: 0,
      bond: near.attachedDeposit().toString(), slashes: 0 });
    return true;
  }

  /** Top up (or first) bond on an existing seat — permissionless: the
   *  bond protects the protocol, so anyone may fund it. */
  @call({ payableFunction: true })
  bondOracle({ oraclePubkey }) {
    this._ensure();
    const o = this.oracles.get(oraclePubkey);
    assert(o, "oracle not registered");
    assert(near.attachedDeposit() > 0n, "attach a bond");
    o.bond = (BigInt(o.bond ?? "0") + near.attachedDeposit()).toString();
    this.oracles.set(oraclePubkey, o);
    return { bond: o.bond };
  }

  /** Eject an oracle: the owner can retire their own seat; the contract
   * account can eject spam — scoped admin: it cannot move funds, only
   * stop future votes from this pubkey (existing votes stop counting
   * because the tally skips inactive oracles). */
  @call({})
  deactivateOracle({ pubkey }) {
    this._ensure();
    const o = this.oracles.get(pubkey);
    assert(o, "oracle not registered");
    const who = near.predecessorAccountId();
    assert(who === o.owner || who === near.currentAccountId(), "not oracle owner");
    o.active = false;
    this.oracles.set(pubkey, o);
    return true;
  }

  // ---- oracle verdicts: M-of-N owner-account votes on a claim ----

  /** An oracle votes on a pending claim. Caller MUST be the registered
   * oracle's owner account — settlement authority is the account, the
   * ed25519 verdictSig is carried as off-chain evidence (TEE chain).
   * Latest vote wins so an oracle can correct a mistake; every rewrite
   * is public state.
   * `conf` (optional, 0–100) is the juror's confidence — recorded on the
   * vote so callers can distinguish a unanimous high-confidence result
   * (auto-settle) from a split/weak one (escalate to the dispute lane).
   * Refused outright on commitReveal markets — blind voting only. */
  @call({ payableFunction: true })
  submitVerdict({ marketId, claimId, verdict, conf, oraclePubkey, verdictSig }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    assert(!m.commitReveal, "commit-reveal market: use commitVerdict/revealVerdict");
    const oracle = this.oracles.get(oraclePubkey);
    assert(oracle && oracle.active, "oracle not active");
    assert(near.predecessorAccountId() === oracle.owner,
      "verdict must come from the oracle owner account");
    this._castVerdict(m, marketId, claimId, verdict, conf, verdictSig, oraclePubkey, oracle);
    return this._tally(marketId, String(claimId));
  }

  /** Phase 1 of blind voting: post sha256 of the verdict preimage —
   *  sha256_hex(marketId|claimId|verdict|conf|salt|oraclePubkey).
   *  Nothing about the vote is public yet, so a juror cannot copy
   *  the majority before committing their own call. */
  @call({})
  commitVerdict({ marketId, oraclePubkey, commit }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    assert(m.commitReveal, "market is not commit-reveal");
    const oracle = this.oracles.get(oraclePubkey);
    assert(oracle && oracle.active, "oracle not active");
    assert(near.predecessorAccountId() === oracle.owner,
      "commit must come from the oracle owner account");
    assert(typeof commit === "string" && /^[0-9a-f]{64}$/.test(commit),
      "commit must be a lowercase sha256 hex digest");
    m.commits ??= {};
    m.commits[oraclePubkey] = commit;
    this.markets.set(marketId, m);
    return { commits: Object.keys(m.commits).length,
             quorumM: m.oracleQuorumM ?? DEFAULT_QUORUM_M };
  }

  /** Phase 2: reveal the preimage. Gated on quorum-many commits so the
   *  ballot stays blind until the jury is committed — one juror can't
   *  lock everyone else into a leaked verdict. A matching hash casts
   *  the real vote. */
  @call({ payableFunction: true })
  revealVerdict({ marketId, claimId, verdict, conf, salt, verdictSig, oraclePubkey }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    assert(m.commitReveal, "market is not commit-reveal");
    const oracle = this.oracles.get(oraclePubkey);
    assert(oracle && oracle.active, "oracle not active");
    assert(near.predecessorAccountId() === oracle.owner,
      "reveal must come from the oracle owner account");
    const commit = m.commits?.[oraclePubkey];
    assert(commit, "no commit on file for this oracle");
    const quorum = m.oracleQuorumM ?? DEFAULT_QUORUM_M;
    const committed = Object.keys(m.commits).filter((pk) =>
      this.oracles.get(pk)?.active).length;
    assert(committed >= quorum,
      `reveal needs ${quorum} committed active jurors (have ${committed})`);
    const preimage = `${marketId}|${String(claimId)}|${verdict}|${conf ?? ""}|${salt ?? ""}|${oraclePubkey}`;
    const digest = [...near.sha256(encode(preimage))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    assert(digest === commit, "reveal does not match commit");
    // Commit stays on file — re-revealing the same preimage is a no-op
    // vote rewrite; a changed verdict needs a new commit first.
    this._castVerdict(m, marketId, claimId, verdict, conf, verdictSig, oraclePubkey, oracle);
    return this._tally(marketId, String(claimId));
  }

  _castVerdict(m, marketId, claimId, verdict, conf, verdictSig, oraclePubkey, oracle) {
    const c = this._claim(marketId, claimId);
    assert(c && c.status === "pending", "claim not pending");
    assert(verdict === "accept" || verdict === "reject", "bad verdict");
    assert(conf == null || (Number.isInteger(conf) && conf >= 0 && conf <= 100),
      "conf must be an integer 0-100");
    m.verdicts ??= {};
    const prior = m.verdicts[oraclePubkey];
    if (!prior) {
      // first verdict write from this seat on this market — stake the bytes
      assert(near.attachedDeposit() >= VERDICT_STAKE_YOCTO,
        `verdict storage stake ${VERDICT_STAKE_YOCTO} yocto required`);
      if (near.attachedDeposit() > VERDICT_STAKE_YOCTO) {
        this._transfer(near.predecessorAccountId(),
          near.attachedDeposit() - VERDICT_STAKE_YOCTO);
      }
    }
    m.verdicts[oraclePubkey] = {
      claimId: String(claimId), verdict,
      conf: conf ?? null,
      sig: verdictSig ?? null, ts: near.blockTimestamp().toString(),
    };
    this.markets.set(marketId, m);
    if (verdict === "accept" && prior?.verdict !== "accept") {
      oracle.verdicts += 1;
      this.oracles.set(oraclePubkey, oracle);
    }
  }

  /** Vote tally for a claim: accept/reject counts plus a settlement
   *  signal — `unanimousHighConf` means every counted accept carries
   *  conf >= 90 with zero rejects: the caller may auto-settle. A split
   *  or weak-confidence result should escalate to the dispute lane. */
  _tally(marketId, claimId) {
    const m = this.markets.get(marketId);
    const allow = m.oracleAllowlist ? new Set(m.oracleAllowlist) : null;
    let accepts = 0, rejects = 0, weakConf = false;
    for (const pk of Object.keys(m.verdicts ?? {})) {
      const v = m.verdicts[pk];
      if (v.claimId !== claimId || !this.oracles.get(pk)?.active ||
          (allow && !allow.has(pk))) continue;
      if (v.verdict === "accept") {
        accepts++;
        if (v.conf == null || v.conf < 90) weakConf = true;
      } else rejects++;
    }
    const quorum = m.oracleQuorumM ?? DEFAULT_QUORUM_M;
    return { acceptVotes: accepts, rejectVotes: rejects, quorumM: quorum,
             unanimousHighConf: accepts >= quorum && accepts > 0 && rejects === 0 && !weakConf };
  }

  /** Distinct ACTIVE, allowlisted oracles voting accept on this claim. */
  _acceptVotes(marketId, claimId) {
    const m = this.markets.get(marketId);
    const allow = m.oracleAllowlist ? new Set(m.oracleAllowlist) : null;
    let n = 0;
    for (const pk of Object.keys(m.verdicts ?? {})) {
      const v = m.verdicts[pk];
      if (v.claimId === claimId && v.verdict === "accept" &&
          this.oracles.get(pk)?.active && (!allow || allow.has(pk))) n++;
    }
    return n;
  }

  // ---- agent: bind work to the market (UNBOUNDED submissions) ----
  //
  // Claims are free — no deposit, no cap. Each claim carries the bridge's
  // attestation stamp (relayer + attested flag + forge identity) so the
  // verdict only ever competes real, forge-verified submissions.
  // claimTtlNs on the market bounds how long a claim stays pending;
  // cleanupExpired reclaims the state bytes.

  @call({ payableFunction: true })
  shipClaim({ marketId, claimHash, actor, commits, evidence,
              claimant, forgeId, forgeUserId, relayer, attested,
              payoutIntent }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    const bag = this._claimsBag(marketId) ?? { seq: 0, order: [] };
    const claimId = String(++bag.seq);
    const ttl = BigInt(m.claimTtlNs ?? DEFAULT_CLAIM_TTL_NS.toString());
    const now = near.blockTimestamp();
    const rec = {
      claimId, marketId, claimHash, actor, commits, evidence,
      // payout identity (NEAR acct) vs shippedBy (who called — the relayer)
      claimant: claimant ?? near.predecessorAccountId(),
      shippedBy: near.predecessorAccountId(),
      // anti-sybil key resolved by the bridge from the forge artifact —
      // GitHub numeric user ID / forge DID; NEAR accounts are payout-only.
      forgeId: forgeId ?? null, forgeUserId: forgeUserId ?? null,
      relayer: relayer ?? null,
      // Bridge-out: for NEP-245 escrow the winner may presign an intents
      // withdraw payload (e.g. USDC → their Solana address) so release
      // settles to their home chain in the same tx. The net payout is
      // deterministic at claim time (locked − fee − platformCut), so the
      // intent amount is exact. Malformed/failed intents leave funds
      // safely in the claimant's intents balance — retryable, not lost.
      payoutIntent: payoutIntent ?? null,
      attested: attested === true,
      status: "pending",
      claimDeadline: (now + ttl).toString(),
      ts: now.toString(),
      storageStake: "0",
    };
    // Storage staking: the caller pays for the bytes it writes — spam
    // claims cost the spammer, not the protocol. Returned when the record
    // leaves storage (withdraw / expiry reap); kept for won/lost claims —
    // those are the permanent public scoreboard and stay paid for.
    const bytes = BigInt(JSON.stringify(rec).length +
      `${marketId}:${claimId}`.length);
    const stake = (bytes * YOCTO_PER_BYTE * CLAIM_STORAGE_BPS) / 100n;
    const attached = near.attachedDeposit();
    assert(attached >= stake,
      `claim storage deposit ${stake} yocto required`);
    // Overpay returns — the caller owes exactly the stake, no more.
    if (attached > stake) {
      this._transfer(near.predecessorAccountId(), attached - stake);
    }
    rec.storageStake = stake.toString();
    this.claims.set(`${marketId}:${claimId}`, rec);
    bag.order.push(claimId);
    this.claimBags.set(marketId, bag);
    return claimId;
  }

  /** Storage stake returned to whoever paid it; record removed. */
  _releaseClaim(marketId, claimId) {
    const c = this.claims.get(`${marketId}:${claimId}`);
    if (!c) return null;
    const stake = BigInt(c.storageStake ?? "0");
    this.claims.remove(`${marketId}:${claimId}`);
    if (stake > 0n) this._transfer(c.shippedBy ?? c.claimant, stake);
    return c;
  }

  @call({})
  withdrawClaim({ marketId, claimId }) {
    this._ensure();
    const c = this._claim(marketId, claimId);
    assert(c && c.status === "pending", "no pending claim");
    const who = near.predecessorAccountId();
    assert(who === c.shippedBy || who === c.claimant, "not your claim");
    this._releaseClaim(marketId, claimId);
    return true;
  }

  /** Anyone can reap expired claims — removes the record and refunds the
   * storage stake to whoever paid it. Junk/stale claims never block the
   * market, and dead bytes stop costing the contract real NEAR. */
  @call({})
  cleanupExpired({ marketId, from, limit }) {
    this._ensure();
    const bag = this._claimsBag(marketId);
    assert(bag, "no claims");
    const now = near.blockTimestamp();
    const f = Number(from ?? 0), l = Math.min(Number(limit ?? 100), 200);
    let reaped = 0;
    for (const id of bag.order.slice(f, f + l)) {
      const c = this.claims.get(`${marketId}:${id}`);
      if (c && c.status === "pending" && BigInt(c.claimDeadline) < now) {
        this._releaseClaim(marketId, id);
        reaped++;
      }
    }
    return { reaped, nextFrom: f + l, total: bag.order.length };
  }

  /** Persist lazy loser resolution, paged — release() writes only the
   *  winner so settlement stays O(1); this flips pending non-winners to
   *  "outcompeted" in storage for the durable public record. Callable by
   *  anyone on a settled market; losers who want their reputation record
   *  have the incentive to run it. */
  @call({})
  finalizeLosers({ marketId, from, limit }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === PAID, "market not settled");
    const bag = this._claimsBag(marketId);
    if (!bag) return { finalized: 0 };
    const f = Number(from ?? 0), l = Math.min(Number(limit ?? 50), 100);
    let n = 0;
    for (const id of bag.order.slice(f, f + l)) {
      const c = this.claims.get(`${marketId}:${id}`);
      if (c && c.status === "pending" && c.claimId !== String(m.winningClaimId)) {
        c.status = "outcompeted";
        this._saveClaim(c);
        n++;
      }
    }
    return { finalized: n, nextFrom: f + l, total: bag.order.length };
  }

  /** Drain legacy-state overlay entries into storage, bounded — each
   *  swept key shrinks the serialized state blob the contract pays
   *  rent on. Anyone can call; run until remaining: 0. */
  @call({})
  sweepLegacy({ field, limit }) {
    this._ensure();
    const map = { markets: this.markets, claims: this.claims,
      claimBags: this.claimBags, oracles: this.oracles }[field];
    assert(map, "field must be markets|claims|claimBags|oracles");
    const keys = Object.keys(map._overlay ?? {}).slice(0,
      Math.min(Number(limit ?? 50), 200));
    for (const k of keys) map.set(k, map._overlay[k]);
    return { swept: keys.length,
      remaining: Object.keys(map._overlay ?? {}).length };
  }

  // ---- disputes: bonded appeal that freezes settlement until ruled ----

  /** Post a bonded dispute on a claim — permissionless (Kleros-style):
   *  any account can challenge a verdict track by bonding
   *  disputeBondYocto and naming an evidence bundle CID. Open disputes
   *  freeze release() market-wide until the arbitrator rules.
   *  claimId may be null to dispute the whole market (e.g. bad spec). */
  @call({ payableFunction: true })
  dispute({ marketId, claimId, evidenceCid }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    m.disputes ??= {};
    const key = claimId != null ? String(claimId) : "*";
    assert(!m.disputes[key] || m.disputes[key].status !== "open",
      "dispute already open on this claim");
    if (claimId != null) {
      assert(this._claim(marketId, claimId), "claim not found");
    }
    const bond = BigInt(m.disputeBondYocto ?? DEFAULT_DISPUTE_BOND);
    assert(near.attachedDeposit() >= bond, `dispute requires ${bond} yocto bond`);
    const who = near.predecessorAccountId();
    m.disputes[key] = {
      disputer: who, claimId: claimId != null ? String(claimId) : null,
      evidenceCid: evidenceCid ?? null,
      bond: near.attachedDeposit().toString(),
      ts: near.blockTimestamp().toString(), status: "open", ruling: null,
    };
    this.markets.set(marketId, m);
    return { disputed: key, bond: near.attachedDeposit().toString() };
  }

  /** Arbitrator ruling — replaces the oracle verdict on the disputed
   *  claim. Rulings:
   *    pay_claim    → settle escrow to the disputed claim now
   *    reject_claim → claim marked rejected; market stays open
   *    refund       → market void, locked returns to payer
   *    dismiss      → no change; normal adjudication resumes
   *  Bond: upheld rulings (pay/reject/refund) refund the disputer;
   *  dismiss burns it to the DAO sink — frivolous appeals cost. */
  @call({})
  resolveDispute({ marketId, claimId, ruling }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    m.disputes ??= {};
    const key = claimId != null ? String(claimId) : "*";
    const d = m.disputes[key];
    assert(d && d.status === "open", "no open dispute");
    const arb = m.arbitrator || this.arbitrator || near.currentAccountId();
    assert(near.predecessorAccountId() === arb, "not the arbitrator");
    assert(["pay_claim", "reject_claim", "refund", "dismiss"].includes(ruling),
      "bad ruling");
    d.status = "resolved";
    d.ruling = ruling;
    const bond = BigInt(d.bond ?? "0");

    if (ruling === "pay_claim") {
      const winner = this.claims.get(`${marketId}:${String(claimId)}`);
      assert(winner, "disputed claim not found");
      const locked = BigInt(m.locked);
      const fee = (locked * FEE_BPS) / 10000n;
      const platformCut = (locked * BigInt(m.platformBps ?? 0)) / 10000n;
      m.status = PAID; m.paidTo = winner.claimant; m.claimHash = winner.claimHash;
      m.winningClaimId = winner.claimId; m.arbitrated = true;
      // Losers resolve lazily — see release(): O(1) writes here, paged
      // persistence via finalizeLosers.
      winner.status = "won";
      this._saveClaim(winner);
      this._payout(m, winner.claimant, locked - fee - platformCut);
      this._payFees(m, winner, fee, platformCut);
      this._maybeBridgeOut(m, winner);
    } else if (ruling === "reject_claim") {
      const c = this.claims.get(`${marketId}:${String(claimId)}`);
      if (c) {
        c.status = "rejected";
        this._saveClaim(c);
      }
    } else if (ruling === "refund") {
      m.status = REFUNDED; m.arbitrated = true;
      this._payout(m, m.payer, BigInt(m.locked));
    }
    this.markets.set(marketId, m);
    // Slash-on-overturn (upheld rulings only): jurors whose verdict on the
    // disputed claim contradicted the arbitrator forfeit their seat bond
    // to the treasury. refund voids the spec itself — not an oracle fault,
    // so no slash; dismiss proves nothing, so no slash.
    const wrongVerdict = ruling === "pay_claim" ? "reject"
      : ruling === "reject_claim" ? "accept" : null;
    const slashed = [];
    if (wrongVerdict && claimId != null) {
      for (const pk of Object.keys(m.verdicts ?? {})) {
        const v = m.verdicts[pk];
        if (v.claimId !== String(claimId) || v.verdict !== wrongVerdict) continue;
        const o = this.oracles.get(pk);
        const b = BigInt(o?.bond ?? "0");
        if (o && b > 0n) {
          this._transfer(this._sink(), b);
          o.bond = "0";
          o.slashes = (o.slashes ?? 0) + 1;
          this.oracles.set(pk, o);
          slashed.push(pk);
        }
      }
    }
    if (bond > 0n) {
      this._transfer(ruling === "dismiss" ? this._sink() : d.disputer, bond);
    }
    return { ruled: ruling, slashed,
             bondTo: ruling === "dismiss" ? this._sink() : d.disputer };
  }

  /** Contract-level arbitrator (interim — the DAO rotates this to a
   *  Kleros-proxy account). Only the contract account can set it. */
  @call({})
  setArbitrator({ account }) {
    assert(near.predecessorAccountId() === near.currentAccountId(),
      "only contract account sets the arbitrator");
    this.arbitrator = account;
    return true;
  }

  /** Open disputes on a market — release() refuses while any exist. */
  _openDisputes(marketId) {
    const m = this.markets.get(marketId);
    if (!m?.disputes) return [];
    return Object.values(m.disputes).filter((d) => d.status === "open");
  }

  // ---- settlement: verdict-gated release, winner among ALL claims ----

  @call({})
  release({ marketId, verdictSig, oraclePubkey, winningClaimId }) {
    this._ensure();
    const m = this.markets.get(marketId);
    assert(m && m.status === OPEN, "market not open");
    assert(!this._openDisputes(marketId).length, "open dispute freezes release");
    const bag = this._claimsBag(marketId);
    assert(bag && bag.order.length > 0, "no claims");

    const signer = near.signerAccountId();
    const isPayer = signer === m.payer;                    // merge=accept on-chain

    // Winner selection: oracle/payer names the claim. Payer may accept any
    // claim (their money); oracle verdicts only count ATTESTED claims —
    // real forge-verified submissions, never raw contract spam.
    const winner = winningClaimId
      ? this.claims.get(`${marketId}:${String(winningClaimId)}`)
      : (isPayer ? this._firstPending(marketId) : null);
    assert(winner && winner.status === "pending", "winning claim not pending");

    // M-of-N: the caller MAY be an oracle owner casting their accept vote
    // inline (single-call flow for quorum=1 markets), then the tally of
    // distinct active allowlisted oracles must reach oracleQuorumM.
    const oracle = oraclePubkey && this.oracles.get(oraclePubkey);
    if (!isPayer && oracle && oracle.active && !m.commitReveal &&
        near.predecessorAccountId() === oracle.owner) {
      m.verdicts ??= {};
      const cid = winner.claimId;
      const prior = m.verdicts[oraclePubkey];
      m.verdicts[oraclePubkey] = { claimId: cid, verdict: "accept",
        conf: null, sig: verdictSig ?? null, ts: near.blockTimestamp().toString() };
      if (prior?.verdict !== "accept") {
        oracle.verdicts += 1;
        this.oracles.set(oraclePubkey, oracle);
      }
    }
    const votes = this._acceptVotes(marketId, winner.claimId);
    const quorum = m.oracleQuorumM ?? DEFAULT_QUORUM_M;
    assert(isPayer || votes >= quorum,
      `release needs payer or ${quorum} oracle accept votes (have ${votes})`);
    if (!isPayer) {
      assert(winner.attested, "oracle quorum can only settle attested claims");
    }

    const locked = BigInt(m.locked);
    const fee = (locked * FEE_BPS) / 10000n;
    const platformCut = (locked * BigInt(m.platformBps ?? 0)) / 10000n;
    const net = locked - fee - platformCut;
    m.status = PAID;
    m.paidTo = winner.claimant;
    m.claimHash = winner.claimHash;
    m.winningClaimId = winner.claimId;
    if (m.payToHat) m.payoutHatId = m.payToHat;
    // Losers resolve LAZILY: writing "outcompeted" to every pending claim
    // here is O(claims) storage writes — unbounded gas on crowded markets.
    // Instead the market records the winner; reads resolve other pending
    // claims as outcompeted on the fly (getClaims/getClaim), and anyone
    // may page through finalizeLosers to persist the durable record.
    winner.status = "won";
    this._saveClaim(winner);
    this.markets.set(marketId, m);
    this._payout(m, winner.claimant, net);
    this._payFees(m, winner, fee, platformCut);
    this._maybeBridgeOut(m, winner);
    return { paid: winner.claimant, net: net.toString(),
             fee: fee.toString(), platformCut: platformCut.toString(),
             claimHash: m.claimHash,
             winningClaimId: winner.claimId, losers: bag.order.length - 1 };
  }

  // ---- views (public market state — the on-chain bounty board) ----

  @view({})
  getMarket({ marketId }) {
    this._ensure();
    return this.markets.get(marketId);
  }
  /** Dispute docket for a market — open + resolved, publicly auditable. */
  @view({})
  getDisputes({ marketId }) {
    this._ensure();
    const m = this.markets.get(marketId);
    return m ? Object.values(m.disputes ?? {}) : [];
  }
  /** Compat shim: first pending claim or null (pre-multi-claim callers). */
  @view({})
  getClaim({ marketId }) {
    this._ensure();
    return this._firstPending(marketId);
  }
  /** Paginated claims for a market — the competition surface. Pending
   *  claims come first, then resolved — one storage read per claim, so
   *  callers page through arbitrarily large claim sets. On settled
   *  markets losers report "outcompeted" via _resolved (no write). */
  @view({})
  getClaims({ marketId, from, limit }) {
    this._ensure();
    const bag = this._claimsBag(marketId);
    const m = this.markets.get(marketId);
    if (!bag) return { claims: [], total: 0 };
    const f = Number(from ?? 0), l = Math.min(Number(limit ?? CLAIM_PAGE), 200);
    const pending = [];
    const resolved = [];
    for (const id of bag.order) {
      const c = this.claims.get(`${marketId}:${id}`);
      if (!c) continue;
      const r = m ? this._resolved(m, c) : c;
      (r.status === "pending" ? pending : resolved).push(r);
    }
    const all = [...pending, ...resolved];
    return { claims: all.slice(f, f + l), total: all.length,
             pending: pending.length };
  }
  @view({})
  getOracle({ pubkey }) {
    this._ensure();
    return this.oracles.get(pubkey);
  }
  @view({})
  listOracles() {
    this._ensure();
    return this.oracleKeys
      .map((pubkey) => ({ pubkey, ...this.oracles.get(pubkey) }))
      .filter((o) => o.owner);
  }
  /** Public jury surface: every oracle's vote + current accept tally per
   * claim — anyone can watch a quorum form (or refuse to). */
  @view({})
  getVerdicts({ marketId }) {
    this._ensure();
    const m = this.markets.get(marketId);
    if (!m) return null;
    const tally = {};
    for (const v of Object.values(m.verdicts ?? {})) {
      if (v.verdict === "accept") tally[v.claimId] = (tally[v.claimId] ?? 0) + 1;
    }
    return { quorumM: m.oracleQuorumM ?? DEFAULT_QUORUM_M,
             allowlist: m.oracleAllowlist ?? null,
             votes: m.verdicts ?? {}, acceptTally: tally };
  }
  /** Paginated market enumeration — one read per market, paged by id. */
  @view({})
  listOpen({ from, limit } = {}) {
    this._ensure();
    const f = Number(from ?? 0), l = Math.min(Number(limit ?? CLAIM_PAGE), 200);
    const open = [];
    for (const id of this.marketIds) {
      const m = this.markets.get(id);
      if (m && m.status === OPEN) open.push(m);
    }
    return open.slice(f, f + l);
  }
  @view({})
  listAll({ from, limit } = {}) {
    this._ensure();
    const f = Number(from ?? 0), l = Math.min(Number(limit ?? CLAIM_PAGE), 200);
    return this.marketIds
      .slice(f, f + l)
      .map((id) => this.markets.get(id))
      .filter(Boolean);
  }

  // ---- internal ----

  /** Per-market claim index {seq, order} — claims themselves live under
   *  `cl` as `${marketId}:${claimId}` entries, so a market scales to any
   *  number of pending claims at O(1) per write. */
  _claimsBag(marketId) {
    return this.claimBags.get(marketId) ?? null;
  }

  _pendingClaims(marketId) {
    const bag = this._claimsBag(marketId);
    if (!bag) return [];
    return bag.order.map((id) => this.claims.get(`${marketId}:${id}`)).filter((c) => c && c.status === "pending");
  }

  /** Early-exit pending checks — O(1) reads for the common case. */
  _hasPending(marketId) {
    return this._firstPending(marketId) !== null;
  }

  _firstPending(marketId) {
    const bag = this._claimsBag(marketId);
    if (!bag) return null;
    for (const id of bag.order) {
      const c = this.claims.get(`${marketId}:${id}`);
      if (c && c.status === "pending") return c;
    }
    return null;
  }

  /** Read-side resolution: on a settled market, a pending claim that
   *  isn't the winner is outcompeted — shown without a storage write.
   *  finalizeLosers persists the same status durably, paged. */
  _resolved(m, c) {
    if (c && c.status === "pending" && m.status === PAID &&
        String(m.winningClaimId) !== c.claimId) {
      return { ...c, status: "outcompeted" };
    }
    return c;
  }

  _transfer(to, amount) {
    // plain NEAR transfer = promise batch with a single transfer action —
    // no method name involved (promiseCreate is for function calls).
    const idx = near.promiseBatchCreate(to);
    near.promiseBatchActionTransfer(idx, amount);
  }

  /** Settlement leg in the market's escrowed asset. Native NEAR pays by
   *  transfer; FT/mt markets call the token contract. A leading
   *  storage_deposit(registration_only) covers unregistered receivers —
   *  standard NEP-141 FTs and the intents contract both implement it,
   *  and it refunds in full when the account is already registered, so
   *  the contract only pays storage for genuinely new holders. */
  /** Settlement fee split: accept-voters on the winning claim share
   *  JUROR_SHARE_BPS of the protocol fee (paid to seat owner accounts,
   *  in the escrowed token); the remainder + rounding dust goes to the
   *  sink. The worker's net and the platform cut are untouched. */
  _payFees(m, winner, fee, platformCut) {
    const jurors = Object.entries(m.verdicts ?? {})
      .filter(([, v]) => v.verdict === "accept" && v.claimId === winner.claimId)
      .map(([pk]) => this.oracles.get(pk)?.owner)
      .filter(Boolean);
    let sinkCut = fee;
    if (jurors.length) {
      const pool = (fee * JUROR_SHARE_BPS) / 10000n;
      const each = pool / BigInt(jurors.length);
      let paid = 0n;
      for (const owner of jurors) {
        this._payout(m, owner, each);
        paid += each;
      }
      sinkCut = fee - paid;
    }
    if (sinkCut > 0n) this._payout(m, this._sink(), sinkCut);
    if (platformCut > 0n) this._payout(m, m.platformTo ?? this._sink(), platformCut);
  }

  _payout(m, to, amount) {
    if (amount <= 0n) return;
    if (!m.token) { this._transfer(to, amount); return; }
    const idx = near.promiseBatchCreate(m.token);
    near.promiseBatchActionFunctionCall(idx, "storage_deposit",
      JSON.stringify({ account_id: to, registration_only: true }),
      STORAGE_DEPOSIT_YOCTO, 10_000_000_000_000n);
    const args = m.tokenId
      ? { receiver_id: to, token_id: m.tokenId, amount: amount.toString() }
      : { receiver_id: to, amount: amount.toString() };
    near.promiseBatchActionFunctionCall(idx, m.tokenId ? "mt_transfer" : "ft_transfer",
      JSON.stringify(args), 1n, 30_000_000_000_000n);
  }

  /** Bridge-out leg: on NEP-245 markets whose winning claim presigned a
   *  withdraw intent, execute_intents runs on the token contract in the
   *  same tx — receipts to the same receiver execute in scheduling
   *  order, so the intent fires after the mt_transfer lands. If the
   *  intent is stale or malformed the funds stay in the claimant's
   *  intents balance — retriable, never lost. */
  _maybeBridgeOut(m, winner) {
    if (!m.tokenId || !winner.payoutIntent) return;
    const idx = near.promiseBatchCreate(m.token);
    near.promiseBatchActionFunctionCall(idx, "execute_intents",
      JSON.stringify({ signed: winner.payoutIntent }),
      0n, 60_000_000_000_000n);
  }
}
