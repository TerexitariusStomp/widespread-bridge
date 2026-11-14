// widespread permissionless market on NEAR — Rust port of contract.src.js.
//
// STATE FORMAT COMPATIBILITY (load-bearing):
// The pre-existing contract is near-sdk-js. Its root state lives under the
// raw storage key "STATE" as JSON:
//   {"markets":{"keyPrefix":"mk","_overlay":{}}, "claims":{"keyPrefix":"cl",...},
//    "claimBags":{...}, "oracles":{...}, "marketIds":[..], "oracleKeys":[..],
//    "arbitrator":"", "feeSink":"", "nextId":30}
// Collection entries live at raw UTF-8 storage keys `prefix + key`
// (e.g. "mk29"), values are JSON. This file reproduces that layout exactly
// by serializing `Contract` through serde_json instead of borsh — the
// manual Borsh* impls below just delegate to JSON, so near-sdk's automatic
// state load/save keeps reading and writing the JS-compatible blob.
// Do NOT switch the struct to a derived borsh format.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Map, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

// ---- constants (identical to the JS contract) ----
const OPEN: &str = "open";
const PAID: &str = "paid";
const REFUNDED: &str = "refunded";
const EXPIRED: &str = "expired";
const DAO_SINK: &str = "widespread-dao.near";
const FEE_BPS: u128 = 200; // 2%
const DEFAULT_CLAIM_TTL_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
const CLAIM_PAGE: i64 = 50;
const DEFAULT_QUORUM_M: i64 = 1;
const MAX_QUORUM_M: i64 = 15;
const DEFAULT_DISPUTE_BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const STORAGE_DEPOSIT_YOCTO: u128 = 1_250_000_000_000_000_000_000;
const CLAIM_STORAGE_BPS: u128 = 120;
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;
const VERDICT_STAKE_YOCTO: u128 = 2_500_000_000_000_000_000_000; // 0.0025 NEAR
// Juror share of the fee AMOUNT, deducted from the winning claimant's net
// — claimants fund adjudication, not the protocol. 5000 bps of the 2% fee
// = 1% of escrow to the jury that accepted the winning claim.
const JUROR_SHARE_BPS: u128 = 5000;

// ---- storage helpers ----

/// LazyMap equivalent: reads storage key `prefix+key` first, then the
/// serialized overlay (legacy/legacy-migrated entries). Writes evict the
/// overlay copy so reads stay view-safe — same contract as the JS version.
#[derive(Clone)]
struct LazyMap {
    prefix: String,
    overlay: Map<String, Value>,
}

impl LazyMap {
    fn key(&self, k: &str) -> Vec<u8> {
        format!("{}{}", self.prefix, k).into_bytes()
    }
    fn get(&self, k: &str) -> Option<Value> {
        if let Some(raw) = env::storage_read(&self.key(k)) {
            return serde_json::from_slice(&raw).ok();
        }
        self.overlay.get(k).cloned()
    }
    fn set(&mut self, k: &str, v: Value) {
        self.overlay.remove(k);
        env::storage_write(&self.key(k), &serde_json::to_vec(&v).unwrap());
    }
    fn remove(&mut self, k: &str) {
        self.overlay.remove(k);
        env::storage_remove(&self.key(k));
    }
}

/// Hydrate one collection field from its serialized form:
/// {keyPrefix, _overlay} → map with prefix; anything else object-shaped →
/// legacy plain-object state whose entries become the overlay. Returns
/// Some(overlay) when the field held legacy plain data (JS `hydra`).
fn hydra(v: Option<&Value>, prefix: &str) -> (LazyMap, Option<Map<String, Value>>) {
    let obj = v.and_then(|x| x.as_object()).cloned().unwrap_or_default();
    if let Some(kp) = obj.get("keyPrefix").and_then(|x| x.as_str()) {
        let overlay = obj
            .get("_overlay")
            .and_then(|x| x.as_object())
            .cloned()
            .unwrap_or_default();
        return (LazyMap { prefix: kp.to_string(), overlay }, None);
    }
    (LazyMap { prefix: prefix.to_string(), overlay: obj.clone() }, Some(obj))
}

pub struct Root {
    markets: LazyMap,
    claims: LazyMap,
    claim_bags: LazyMap,
    oracles: LazyMap,
    market_ids: Vec<String>,
    oracle_keys: Vec<String>,
    arbitrator: String,
    fee_sink: String,
    next_id: u64,
}

// JSON root serialization — identical field names to the JS state blob.
impl Serialize for Root {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let map = |m: &LazyMap| -> Value {
            json!({"keyPrefix": m.prefix, "_overlay": Value::Object(m.overlay.clone())})
        };
        json!({
            "markets": map(&self.markets),
            "claims": map(&self.claims),
            "claimBags": map(&self.claim_bags),
            "oracles": map(&self.oracles),
            "marketIds": self.market_ids,
            "oracleKeys": self.oracle_keys,
            "arbitrator": self.arbitrator,
            "feeSink": self.fee_sink,
            "nextId": self.next_id,
        })
        .serialize(s)
    }
}

/// State wire format: "STATE" holds serde_json of the root object, exactly
/// as near-sdk-js wrote it. These borsh impls delegate to JSON so near-sdk's
/// automatic state_read/state_write on `Market` round-trips the JS layout.
impl BorshSerialize for Root {
    fn serialize<W: std::io::Write>(&self, w: &mut W) -> std::io::Result<()> {
        w.write_all(&serde_json::to_vec(self).unwrap())
    }
}

impl BorshDeserialize for Root {
    fn deserialize_reader<R: std::io::Read>(r: &mut R) -> std::io::Result<Self> {
        let mut buf = Vec::new();
        r.read_to_end(&mut buf)?;
        let v: Value = serde_json::from_slice(&buf)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        Ok(Self::from_root(&v))
    }
}



// ---- small JSON accessors (records carry heterogeneous fields) ----
fn vs<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}
fn vstr(v: &Value, k: &str) -> String {
    vs(v, k).unwrap_or_default().to_string()
}
fn vnum(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}
fn vbig(v: &Value, k: &str) -> u128 {
    match v.get(k) {
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().map(|x| x as u128).unwrap_or(0),
        _ => 0,
    }
}
fn vobj(v: &Value, k: &str) -> Map<String, Value> {
    v.get(k).and_then(|x| x.as_object()).cloned().unwrap_or_default()
}
fn id_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
fn set(v: &mut Value, k: &str, val: Value) {
    v.as_object_mut().unwrap().insert(k.into(), val);
}
fn acct(s: &str) -> AccountId {
    s.parse().unwrap_or_else(|_| env::current_account_id())
}
fn acct_id(s: &str) -> AccountId {
    s.parse().unwrap()
}

impl Root {
    fn from_root(v: &Value) -> Self {
        let (markets, lm) = hydra(v.get("markets"), "mk");
        let (mut claims, lc) = hydra(v.get("claims"), "cl");
        let (mut claim_bags, _lb) = hydra(v.get("claimBags"), "cb");
        let (oracles, lo) = hydra(v.get("oracles"), "or");
        let mut market_ids: Vec<String> = v
            .get("marketIds")
            .and_then(|x| serde_json::from_value(x.clone()).ok())
            .unwrap_or_default();
        let mut oracle_keys: Vec<String> = v
            .get("oracleKeys")
            .and_then(|x| serde_json::from_value(x.clone()).ok())
            .unwrap_or_default();
        if let Some(m) = lm {
            market_ids = m.keys().cloned().collect();
        }
        if let Some(o) = lo {
            oracle_keys = o.keys().cloned().collect();
        }
        // Legacy nested claim bags {seq, items, order} → per-claim keys.
        if let Some(lc) = lc {
            for (mid, bag) in lc {
                claims.overlay.remove(&mid);
                if let Some(items) = bag.get("items").and_then(|x| x.as_object()) {
                    let mut nb = Map::new();
                    nb.insert("seq".into(), bag.get("seq").cloned().unwrap_or(json!(0)));
                    nb.insert("order".into(), bag.get("order").cloned().unwrap_or(json!([])));
                    claim_bags.overlay.insert(mid.clone(), Value::Object(nb));
                    for (cid, c) in items {
                        claims.overlay.insert(format!("{mid}:{cid}"), c.clone());
                    }
                } else if bag.get("claimHash").is_some() {
                    // oldest shape: claims[mid] was the claim itself
                    claim_bags.overlay.insert(
                        mid.clone(),
                        json!({"seq": 1, "order": ["1"]}),
                    );
                    let mut c = bag.clone();
                    let o = c.as_object_mut().unwrap();
                    o.insert("claimId".into(), json!("1"));
                    o.insert("marketId".into(), json!(mid));
                    o.entry("status").or_insert(json!("pending"));
                    let claimant = vs(&bag, "claimant").unwrap_or_default().to_string();
                    o.insert("shippedBy".into(), json!(claimant));
                    o.insert("attested".into(), json!(true));
                    o.entry("claimDeadline").or_insert(json!("0"));
                    claims.overlay.insert(format!("{mid}:1"), c);
                } else {
                    claims.overlay.insert(mid, bag);
                }
            }
        }
        Root {
            markets, claims, claim_bags, oracles, market_ids, oracle_keys,
            arbitrator: vstr(v, "arbitrator"),
            fee_sink: vstr(v, "feeSink"),
            next_id: v.get("nextId").and_then(|x| x.as_u64()).unwrap_or(1),
        }
    }

    fn sink(&self) -> String {
        if self.fee_sink.is_empty() { DAO_SINK.into() } else { self.fee_sink.clone() }
    }

    fn bag(&self, mid: &str) -> Option<Value> {
        self.claim_bags.get(mid)
    }
    fn claim(&self, mid: &str, cid: &str) -> Option<Value> {
        self.claims.get(&format!("{mid}:{cid}"))
    }
    fn save_claim(&mut self, c: &Value) {
        let k = format!("{}:{}", vstr(c, "marketId"), vstr(c, "claimId"));
        self.claims.set(&k, c.clone());
    }
    fn first_pending(&self, mid: &str) -> Option<Value> {
        let bag = self.bag(mid)?;
        for id in bag.get("order")?.as_array()? {
            let cid = id_of(id);
            if let Some(c) = self.claim(mid, &cid) {
                if vs(&c, "status") == Some("pending") {
                    return Some(c);
                }
            }
        }
        None
    }

    // ---- config ----

    #[allow(non_snake_case)]
    pub fn setFeeSink(&mut self, account: String) -> Value {
        assert!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account can set the fee sink"
        );
        assert!(account.contains('.'), "bad account");
        self.fee_sink = account.clone();
        json!({"feeSink": account})
    }

    #[allow(non_snake_case)]
    pub fn getConfig(&self) -> Value {
        json!({
            "feeBps": FEE_BPS.to_string(),
            "feeSink": self.sink(),
            "arbitrator": self.arbitrator,
            "nextId": self.next_id,
        })
    }

    // ---- funding ----

    #[allow(non_snake_case)]
    pub fn createMarket(&mut self,
        specHash: Option<String>,
        spec: Option<String>,
        deadline: Option<Value>,
        acceptanceRule: Option<String>,
        payToHat: Option<String>,
        claimTtlNs: Option<Value>,
        acceptanceHash: Option<String>,
        platformBps: Option<i64>,
        platformTo: Option<String>,
        oracleQuorumM: Option<i64>,
        oracleAllowlist: Option<Vec<String>>,
        arbitrator: Option<String>,
        disputeBondYocto: Option<String>,
        commitReveal: Option<bool>,
    ) -> String {
        let payer = env::predecessor_account_id().to_string();
        let attached = env::attached_deposit().as_yoctonear();
        assert!(attached > 0, "market must be funded — attach the bounty");
        self.open_market(
            payer, attached, String::new(), String::new(), specHash, spec,
            deadline, acceptanceRule, payToHat, claimTtlNs, acceptanceHash,
            platformBps, platformTo, oracleQuorumM, oracleAllowlist,
            arbitrator, disputeBondYocto, commitReveal,
        )
    }

    /// NEP-141 receiver.
    #[allow(non_snake_case)]
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: String, msg: String) -> String {
        let parsed: Value = serde_json::from_str(&msg).unwrap_or(Value::Null);
        let market = parsed.get("market").cloned().unwrap_or(Value::Null);
        assert!(vs(&parsed, "kind") == Some("open_market") && !market.is_null(),
            "msg must be open_market with market");
        let m = market.as_object().unwrap();
        self.open_market(
            sender_id.to_string(),
            amount.parse().unwrap_or(0),
            env::predecessor_account_id().to_string(),
            String::new(),
            jstr(m, "specHash"), jstr(m, "spec"), m.get("deadline").cloned(),
            jstr(m, "acceptanceRule"), jstr(m, "payToHat"), m.get("claimTtlNs").cloned(),
            jstr(m, "acceptanceHash"), m.get("platformBps").and_then(|x| x.as_i64()),
            jstr(m, "platformTo"), m.get("oracleQuorumM").and_then(|x| x.as_i64()),
            m.get("oracleAllowlist").and_then(|x| serde_json::from_value(x.clone()).ok()),
            jstr(m, "arbitrator"), jstr(m, "disputeBondYocto"),
            m.get("commitReveal").and_then(|x| x.as_bool()),
        );
        "0".into()
    }

    /// NEP-245 receiver.
    #[allow(non_snake_case)]
    pub fn mt_on_transfer(&mut self,
        sender_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<String>,
        msg: String,
    ) -> Value {
        assert!(token_ids.len() == 1 && amounts.len() == 1,
            "one mt token id per market — batch funding refused");
        let parsed: Value = serde_json::from_str(&msg).unwrap_or(Value::Null);
        let market = parsed.get("market").cloned().unwrap_or(Value::Null);
        assert!(vs(&parsed, "kind") == Some("open_market") && !market.is_null(),
            "msg must be open_market with market");
        let m = market.as_object().unwrap();
        self.open_market(
            sender_id.to_string(),
            amounts[0].parse().unwrap_or(0),
            env::predecessor_account_id().to_string(),
            token_ids[0].clone(),
            jstr(m, "specHash"), jstr(m, "spec"), m.get("deadline").cloned(),
            jstr(m, "acceptanceRule"), jstr(m, "payToHat"), m.get("claimTtlNs").cloned(),
            jstr(m, "acceptanceHash"), m.get("platformBps").and_then(|x| x.as_i64()),
            jstr(m, "platformTo"), m.get("oracleQuorumM").and_then(|x| x.as_i64()),
            m.get("oracleAllowlist").and_then(|x| serde_json::from_value(x.clone()).ok()),
            jstr(m, "arbitrator"), jstr(m, "disputeBondYocto"),
            m.get("commitReveal").and_then(|x| x.as_bool()),
        );
        json!({"token_ids": [], "amounts": []})
    }

    #[allow(clippy::too_many_arguments)]
    fn open_market(
        &mut self,
        payer: String, locked: u128, token: String, token_id: String,
        spec_hash: Option<String>, spec: Option<String>, deadline: Option<Value>,
        acceptance_rule: Option<String>, pay_to_hat: Option<String>,
        claim_ttl: Option<Value>, acceptance_hash: Option<String>,
        platform_bps: Option<i64>, platform_to: Option<String>,
        oracle_quorum_m: Option<i64>, oracle_allowlist: Option<Vec<String>>,
        arbitrator: Option<String>, dispute_bond: Option<String>,
        commit_reveal: Option<bool>,
    ) -> String {
        assert!(locked > 0, "market must be funded — attach the bounty");
        assert!(platform_bps.unwrap_or(0) <= 5000, "platformBps above 50% refused");
        let qm = oracle_quorum_m.unwrap_or(DEFAULT_QUORUM_M);
        assert!((1..=MAX_QUORUM_M).contains(&qm), "oracleQuorumM out of range");
        let market_id = self.next_id.to_string();
        self.next_id += 1;
        self.market_ids.push(market_id.clone());
        let ttl = claim_ttl
            .map(|v| id_of(&v))
            .unwrap_or_else(|| DEFAULT_CLAIM_TTL_NS.to_string());
        let m = json!({
            "marketId": market_id,
            "payer": payer,
            "specHash": spec_hash,
            "spec": spec,
            "locked": locked.to_string(),
            "deadline": deadline.unwrap_or(Value::Null),
            "acceptanceRule": acceptance_rule,
            "token": token,
            "tokenId": token_id,
            "acceptanceHash": acceptance_hash,
            "claimTtlNs": ttl,
            "payToHat": pay_to_hat,
            "platformBps": platform_bps.unwrap_or(0),
            "platformTo": platform_to,
            "oracleQuorumM": qm,
            "oracleAllowlist": oracle_allowlist,
            "verdicts": {},
            "commitReveal": commit_reveal == Some(true),
            "commits": {},
            "arbitrator": arbitrator,
            "disputeBondYocto": dispute_bond,
            "disputes": {},
            "status": OPEN,
            "createdAt": env::block_timestamp().to_string(),
        });
        self.markets.set(&market_id, m);
        self.claim_bags.set(&market_id, json!({"seq": 0, "order": []}));
        market_id
    }

    #[allow(non_snake_case)]
    pub fn refund(&mut self, marketId: String) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        let expired = m.get("deadline")
            .and_then(|d| if d.is_null() { None } else { Some(id_of(d)) })
            .map(|d| env::block_timestamp() > d.parse::<u64>().unwrap_or(u64::MAX))
            .unwrap_or(false);
        if !expired {
            let open = vobj(&m, "disputes").values()
                .any(|d| vs(d, "status") == Some("open"));
            assert!(!open, "open dispute freezes refund");
        }
        let payer = vstr(&m, "payer");
        let no_pending = self.first_pending(&marketId).is_none();
        assert!(
            (env::predecessor_account_id().to_string() == payer && no_pending) || expired,
            "market is live with pending claims"
        );
        set(&mut m, "status", json!(if expired { EXPIRED } else { REFUNDED }));
        let locked = vbig(&m, "locked");
        self.markets.set(&marketId, m.clone());
        self.payout(&m, &payer, locked);
        json!({"refunded": payer, "amount": locked.to_string(), "status": vs(&m, "status")})
    }

    // ---- oracle registry ----

    #[allow(non_snake_case)]
    pub fn registerOracle(&mut self, pubkey: String) -> bool {
        let who = env::predecessor_account_id().to_string();
        assert!(self.oracles.get(&pubkey).is_none(), "oracle already registered");
        self.oracle_keys.push(pubkey.clone());
        self.oracles.set(&pubkey, json!({
            "active": true, "owner": who, "verdicts": 0, "disputes": 0,
            "bond": env::attached_deposit().as_yoctonear().to_string(),
            "slashes": 0,
        }));
        true
    }

    #[allow(non_snake_case)]
    pub fn bondOracle(&mut self, oraclePubkey: String) -> Value {
        let mut o = self.oracles.get(&oraclePubkey).expect("oracle not registered");
        let dep = env::attached_deposit().as_yoctonear();
        assert!(dep > 0, "attach a bond");
        let bond = vbig(&o, "bond") + dep;
        set(&mut o, "bond", json!(bond.to_string()));
        self.oracles.set(&oraclePubkey, o);
        json!({"bond": bond.to_string()})
    }

    #[allow(non_snake_case)]
    pub fn deactivateOracle(&mut self, pubkey: String) -> bool {
        let mut o = self.oracles.get(&pubkey).expect("oracle not registered");
        let who = env::predecessor_account_id();
        assert!(who.to_string() == vstr(&o, "owner") || who == env::current_account_id(),
            "not oracle owner");
        set(&mut o, "active", json!(false));
        self.oracles.set(&pubkey, o);
        true
    }

    // ---- verdicts ----

    #[allow(non_snake_case)]
    pub fn submitVerdict(&mut self, marketId: String, claimId: Value, verdict: String,
        conf: Option<i64>, oraclePubkey: String, verdictSig: Option<String>,
    ) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        assert!(m.get("commitReveal").and_then(|x| x.as_bool()) != Some(true),
            "commit-reveal market: use commitVerdict/revealVerdict");
        let mut oracle = self.oracles.get(&oraclePubkey).expect("oracle not active");
        assert!(oracle.get("active").and_then(|x| x.as_bool()) == Some(true), "oracle not active");
        assert!(env::predecessor_account_id().to_string() == vstr(&oracle, "owner"),
            "verdict must come from the oracle owner account");
        self.cast_verdict(&mut m, &marketId, &id_of(&claimId), &verdict, conf,
            verdictSig, &oraclePubkey, &mut oracle);
        self.tally(&marketId, &id_of(&claimId))
    }

    #[allow(non_snake_case)]
    pub fn commitVerdict(&mut self, marketId: String, oraclePubkey: String, commit: String) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        assert!(m.get("commitReveal").and_then(|x| x.as_bool()) == Some(true),
            "market is not commit-reveal");
        let oracle = self.oracles.get(&oraclePubkey).expect("oracle not active");
        assert!(oracle.get("active").and_then(|x| x.as_bool()) == Some(true), "oracle not active");
        assert!(env::predecessor_account_id().to_string() == vstr(&oracle, "owner"),
            "commit must come from the oracle owner account");
        assert!(commit.len() == 64 && commit.chars().all(|c| c.is_ascii_hexdigit())
            && commit.chars().all(|c| !c.is_ascii_uppercase()),
            "commit must be a lowercase sha256 hex digest");
        let mut commits = vobj(&m, "commits");
        commits.insert(oraclePubkey.clone(), json!(commit));
        set(&mut m, "commits", Value::Object(commits.clone()));
        self.markets.set(&marketId, m.clone());
        json!({"commits": commits.len(),
               "quorumM": vnum(&m, "oracleQuorumM").unwrap_or(DEFAULT_QUORUM_M)})
    }

    #[allow(non_snake_case)]
    pub fn revealVerdict(&mut self, marketId: String, claimId: Value, verdict: String,
        conf: Option<i64>, salt: Option<String>, verdictSig: Option<String>,
        oraclePubkey: String,
    ) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        assert!(m.get("commitReveal").and_then(|x| x.as_bool()) == Some(true),
            "market is not commit-reveal");
        let mut oracle = self.oracles.get(&oraclePubkey).expect("oracle not active");
        assert!(oracle.get("active").and_then(|x| x.as_bool()) == Some(true), "oracle not active");
        assert!(env::predecessor_account_id().to_string() == vstr(&oracle, "owner"),
            "reveal must come from the oracle owner account");
        let commits = vobj(&m, "commits");
        let commit = commits.get(&oraclePubkey).and_then(|x| x.as_str())
            .expect("no commit on file for this oracle").to_string();
        let quorum = vnum(&m, "oracleQuorumM").unwrap_or(DEFAULT_QUORUM_M);
        let committed = commits.keys().filter(|pk| {
            self.oracles.get(pk)
                .and_then(|o| o.get("active").and_then(|x| x.as_bool()))
                .unwrap_or(false)
        }).count() as i64;
        assert!(committed >= quorum, "reveal needs quorum committed jurors");
        let conf_s = conf.map(|c| c.to_string()).unwrap_or_default();
        let preimage = format!("{}|{}|{}|{}|{}|{}",
            marketId, id_of(&claimId), verdict, conf_s,
            salt.unwrap_or_default(), oraclePubkey);
        let digest: String = env::sha256(preimage.as_bytes())
            .iter().map(|b| format!("{b:02x}")).collect();
        assert!(digest == commit, "reveal does not match commit");
        self.cast_verdict(&mut m, &marketId, &id_of(&claimId), &verdict, conf,
            verdictSig, &oraclePubkey, &mut oracle);
        self.tally(&marketId, &id_of(&claimId))
    }

    fn cast_verdict(
        &mut self, m: &mut Value, market_id: &str, claim_id: &str, verdict: &str,
        conf: Option<i64>, verdict_sig: Option<String>, pubkey: &str, oracle: &mut Value,
    ) {
        let c = self.claim(market_id, claim_id).expect("claim not pending");
        assert!(vs(&c, "status") == Some("pending"), "claim not pending");
        assert!(verdict == "accept" || verdict == "reject", "bad verdict");
        if let Some(cf) = conf {
            assert!((0..=100).contains(&cf), "conf must be an integer 0-100");
        }
        let mut verdicts = vobj(m, "verdicts");
        let prior = verdicts.get(pubkey).cloned();
        if prior.is_none() {
            let dep = env::attached_deposit().as_yoctonear();
            assert!(dep >= VERDICT_STAKE_YOCTO,
                "verdict storage stake 2500000000000000000000 yocto required");
            if dep > VERDICT_STAKE_YOCTO {
                self.transfer(&env::predecessor_account_id().to_string(), dep - VERDICT_STAKE_YOCTO);
            }
        }
        let prior_accept = prior.as_ref()
            .and_then(|p| vs(p, "verdict")).map(|s| s.to_string());
        verdicts.insert(pubkey.to_string(), json!({
            "claimId": claim_id, "verdict": verdict,
            "conf": conf, "sig": verdict_sig,
            "ts": env::block_timestamp().to_string(),
        }));
        set(m, "verdicts", Value::Object(verdicts));
        self.markets.set(market_id, m.clone());
        if verdict == "accept" && prior_accept.as_deref() != Some("accept") {
            let n = vnum(oracle, "verdicts").unwrap_or(0) + 1;
            set(oracle, "verdicts", json!(n));
            self.oracles.set(pubkey, oracle.clone());
        }
    }

    fn tally(&self, market_id: &str, claim_id: &str) -> Value {
        let m = self.markets.get(market_id).unwrap();
        let allow: Option<Vec<String>> = m.get("oracleAllowlist")
            .and_then(|x| serde_json::from_value(x.clone()).ok());
        let (mut accepts, mut rejects, mut weak) = (0i64, 0i64, false);
        for (pk, v) in vobj(&m, "verdicts") {
            if vs(&v, "claimId") != Some(claim_id) { continue; }
            let active = self.oracles.get(&pk)
                .and_then(|o| o.get("active").and_then(|x| x.as_bool()))
                .unwrap_or(false);
            if !active { continue; }
            if let Some(a) = &allow { if !a.contains(&pk) { continue; } }
            if vs(&v, "verdict") == Some("accept") {
                accepts += 1;
                if v.get("conf").is_none() || v.get("conf").unwrap().is_null()
                    || vnum(&v, "conf").unwrap_or(0) < 90 { weak = true; }
            } else { rejects += 1; }
        }
        let quorum = vnum(&m, "oracleQuorumM").unwrap_or(DEFAULT_QUORUM_M);
        json!({"acceptVotes": accepts, "rejectVotes": rejects, "quorumM": quorum,
               "unanimousHighConf": accepts >= quorum && accepts > 0 && rejects == 0 && !weak})
    }

    fn accept_votes(&self, market_id: &str, claim_id: &str) -> i64 {
        self.tally(market_id, claim_id).get("acceptVotes").unwrap().as_i64().unwrap()
    }

    // ---- claims ----

    #[allow(non_snake_case, clippy::too_many_arguments)]
    pub fn shipClaim(&mut self, marketId: String, claimHash: Option<String>, actor: Option<String>,
        commits: Option<Value>, evidence: Option<Value>, claimant: Option<String>,
        forgeId: Option<String>, forgeUserId: Option<String>, relayer: Option<String>,
        attested: Option<bool>, payoutIntent: Option<Value>,
    ) -> String {
        let m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        let mut bag = self.bag(&marketId).unwrap_or(json!({"seq": 0, "order": []}));
        let seq = vnum(&bag, "seq").unwrap_or(0) + 1;
        let claim_id = seq.to_string();
        let ttl: u64 = id_of(m.get("claimTtlNs").unwrap_or(&Value::Null))
            .parse().unwrap_or(DEFAULT_CLAIM_TTL_NS);
        let now = env::block_timestamp();
        let predecessor = env::predecessor_account_id().to_string();
        let mut rec = json!({
            "claimId": claim_id, "marketId": marketId,
            "claimHash": claimHash, "actor": actor,
            "commits": commits.unwrap_or(Value::Null), "evidence": evidence.unwrap_or(Value::Null),
            "claimant": claimant.unwrap_or_else(|| predecessor.clone()),
            "shippedBy": predecessor,
            "forgeId": forgeId, "forgeUserId": forgeUserId,
            "relayer": relayer, "payoutIntent": payoutIntent.unwrap_or(Value::Null),
            "attested": attested == Some(true),
            "status": "pending",
            "claimDeadline": (now + ttl).to_string(),
            "ts": now.to_string(),
            "storageStake": "0",
        });
        let bytes = (serde_json::to_string(&rec).unwrap().len()
            + format!("{marketId}:{claim_id}").len()) as u128;
        let stake = bytes * YOCTO_PER_BYTE * CLAIM_STORAGE_BPS / 100;
        let attached = env::attached_deposit().as_yoctonear();
        assert!(attached >= stake,
            "claim storage deposit too small");
        if attached > stake {
            self.transfer(&env::predecessor_account_id().to_string(), attached - stake);
        }
        set(&mut rec, "storageStake", json!(stake.to_string()));
        self.claims.set(&format!("{marketId}:{claim_id}"), rec);
        set(&mut bag, "seq", json!(seq));
        bag.get_mut("order").unwrap().as_array_mut().unwrap().push(json!(claim_id));
        self.claim_bags.set(&marketId, bag);
        claim_id
    }

    fn release_claim(&mut self, market_id: &str, claim_id: &str) -> Option<Value> {
        let c = self.claims.get(&format!("{market_id}:{claim_id}"))?;
        let stake = vbig(&c, "storageStake");
        self.claims.remove(&format!("{market_id}:{claim_id}"));
        if stake > 0 {
            let to = vs(&c, "shippedBy").or_else(|| vs(&c, "claimant")).unwrap_or("");
            self.transfer(to, stake);
        }
        Some(c)
    }

    #[allow(non_snake_case)]
    pub fn withdrawClaim(&mut self, marketId: String, claimId: Value) -> bool {
        let cid = id_of(&claimId);
        let c = self.claim(&marketId, &cid).expect("no pending claim");
        assert!(vs(&c, "status") == Some("pending"), "no pending claim");
        let who = env::predecessor_account_id().to_string();
        assert!(who == vstr(&c, "shippedBy") || who == vstr(&c, "claimant"), "not your claim");
        self.release_claim(&marketId, &cid);
        true
    }

    #[allow(non_snake_case)]
    pub fn cleanupExpired(&mut self, marketId: String, from: Option<i64>, limit: Option<i64>) -> Value {
        let bag = self.bag(&marketId).expect("no claims");
        let now = env::block_timestamp();
        let order = bag.get("order").unwrap().as_array().unwrap().clone();
        let f = from.unwrap_or(0).max(0) as usize;
        let l = limit.unwrap_or(100).clamp(0, 200) as usize;
        let mut reaped = 0;
        for id in order.iter().skip(f).take(l) {
            let cid = id_of(id);
            if let Some(c) = self.claim(&marketId, &cid) {
                let expired = vs(&c, "status") == Some("pending")
                    && vbig(&c, "claimDeadline") < now as u128;
                if expired { self.release_claim(&marketId, &cid); reaped += 1; }
            }
        }
        json!({"reaped": reaped, "nextFrom": f + l, "total": order.len()})
    }

    #[allow(non_snake_case)]
    pub fn finalizeLosers(&mut self, marketId: String, from: Option<i64>, limit: Option<i64>) -> Value {
        let m = self.markets.get(&marketId).expect("market not settled");
        assert!(vs(&m, "status") == Some(PAID), "market not settled");
        let bag = match self.bag(&marketId) {
            Some(b) => b, None => return json!({"finalized": 0}),
        };
        let order = bag.get("order").unwrap().as_array().unwrap().clone();
        let f = from.unwrap_or(0).max(0) as usize;
        let l = limit.unwrap_or(50).clamp(0, 100) as usize;
        let winner_id = vstr(&m, "winningClaimId");
        let mut n = 0;
        for id in order.iter().skip(f).take(l) {
            let cid = id_of(id);
            if let Some(mut c) = self.claim(&marketId, &cid) {
                if vs(&c, "status") == Some("pending") && cid != winner_id {
                    set(&mut c, "status", json!("outcompeted"));
                    self.save_claim(&c);
                    n += 1;
                }
            }
        }
        json!({"finalized": n, "nextFrom": f + l, "total": order.len()})
    }

    #[allow(non_snake_case)]
    pub fn sweepLegacy(&mut self, field: String, limit: Option<i64>) -> Value {
        let map = match field.as_str() {
            "markets" => &mut self.markets,
            "claims" => &mut self.claims,
            "claimBags" => &mut self.claim_bags,
            "oracles" => &mut self.oracles,
            _ => env::panic_str("field must be markets|claims|claimBags|oracles"),
        };
        let keys: Vec<String> = map.overlay.keys().cloned()
            .take(limit.unwrap_or(50).clamp(0, 200) as usize).collect();
        let n = keys.len();
        for k in keys {
            let v = map.overlay.get(&k).cloned().unwrap();
            map.set(&k, v);
        }
        json!({"swept": n, "remaining": map.overlay.len()})
    }

    // ---- disputes ----

    #[allow(non_snake_case)]
    pub fn dispute(&mut self, marketId: String, claimId: Option<Value>, evidenceCid: Option<String>) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        let cid = claimId.and_then(|c| if c.is_null() { None } else { Some(id_of(&c)) });
        let key = cid.clone().unwrap_or_else(|| "*".into());
        let mut disputes = vobj(&m, "disputes");
        assert!(disputes.get(&key).and_then(|d| vs(d, "status")) != Some("open"),
            "dispute already open on this claim");
        if let Some(c) = &cid {
            assert!(self.claim(&marketId, c).is_some(), "claim not found");
        }
        let bond = match m.get("disputeBondYocto") {
            Some(v) if !v.is_null() => vbig(&m, "disputeBondYocto"),
            _ => DEFAULT_DISPUTE_BOND,
        };
        let dep = env::attached_deposit().as_yoctonear();
        assert!(dep >= bond, "dispute bond too small");
        let who = env::predecessor_account_id().to_string();
        disputes.insert(key.clone(), json!({
            "disputer": who, "claimId": cid,
            "evidenceCid": evidenceCid,
            "bond": dep.to_string(),
            "ts": env::block_timestamp().to_string(),
            "status": "open", "ruling": Value::Null,
        }));
        set(&mut m, "disputes", Value::Object(disputes));
        self.markets.set(&marketId, m);
        json!({"disputed": key, "bond": dep.to_string()})
    }

    #[allow(non_snake_case)]
    pub fn resolveDispute(&mut self, marketId: String, claimId: Option<Value>, ruling: String) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        let cid = claimId.and_then(|c| if c.is_null() { None } else { Some(id_of(&c)) });
        let key = cid.clone().unwrap_or_else(|| "*".into());
        let mut disputes = vobj(&m, "disputes");
        let d = disputes.get(&key).cloned().expect("no open dispute");
        assert!(vs(&d, "status") == Some("open"), "no open dispute");
        let arb = vs(&m, "arbitrator").filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| if self.arbitrator.is_empty() {
                env::current_account_id().to_string()
            } else { self.arbitrator.clone() });
        assert!(env::predecessor_account_id().to_string() == arb, "not the arbitrator");
        assert!(["pay_claim", "reject_claim", "refund", "dismiss"].contains(&ruling.as_str()),
            "bad ruling");
        let mut d = d;
        set(&mut d, "status", json!("resolved"));
        set(&mut d, "ruling", json!(ruling));
        disputes.insert(key.clone(), d.clone());
        set(&mut m, "disputes", Value::Object(disputes));
        let bond = vbig(&d, "bond");

        if ruling == "pay_claim" {
            let winner = self.claim(&marketId, cid.as_deref().unwrap())
                .expect("disputed claim not found");
            let locked = vbig(&m, "locked");
            let fee = locked * FEE_BPS / 10000;
            let platform_cut = locked * vbig(&m, "platformBps") / 10000;
            let juror_pool = if self.jurors_of(&m, &vstr(&winner, "claimId")).is_empty() { 0 }
                else { fee * JUROR_SHARE_BPS / 10000 };
            set(&mut m, "status", json!(PAID));
            set(&mut m, "paidTo", json!(vstr(&winner, "claimant")));
            set(&mut m, "claimHash", json!(vstr(&winner, "claimHash")));
            set(&mut m, "winningClaimId", json!(vstr(&winner, "claimId")));
            set(&mut m, "arbitrated", json!(true));
            let mut w = winner.clone();
            set(&mut w, "status", json!("won"));
            self.save_claim(&w);
            self.markets.set(&marketId, m.clone());
            self.payout(&m, &vstr(&winner, "claimant"), locked - fee - platform_cut - juror_pool);
            self.pay_fees(&m, &winner, fee, platform_cut, juror_pool);
            self.maybe_bridge_out(&m, &winner);
        } else if ruling == "reject_claim" {
            if let Some(c) = &cid {
                if let Some(mut cl) = self.claim(&marketId, c) {
                    set(&mut cl, "status", json!("rejected"));
                    self.save_claim(&cl);
                }
            }
            self.markets.set(&marketId, m.clone());
        } else if ruling == "refund" {
            set(&mut m, "status", json!(REFUNDED));
            set(&mut m, "arbitrated", json!(true));
            let payer = vstr(&m, "payer");
            let locked = vbig(&m, "locked");
            self.markets.set(&marketId, m.clone());
            self.payout(&m, &payer, locked);
        } else {
            self.markets.set(&marketId, m.clone());
        }

        // Slash-on-overturn.
        let wrong = if ruling == "pay_claim" { Some("reject") }
            else if ruling == "reject_claim" { Some("accept") } else { None };
        let mut slashed = Vec::new();
        if let (Some(w), Some(cid_s)) = (wrong, cid.as_ref()) {
            for (pk, v) in vobj(&m, "verdicts") {
                if vs(&v, "claimId") != Some(cid_s) || vs(&v, "verdict") != Some(w) { continue; }
                if let Some(mut o) = self.oracles.get(&pk) {
                    let b = vbig(&o, "bond");
                    if b > 0 {
                        let sink = self.sink();
                        self.transfer(&sink, b);
                        set(&mut o, "bond", json!("0"));
                        let sl = vnum(&o, "slashes").unwrap_or(0) + 1;
                        set(&mut o, "slashes", json!(sl));
                        self.oracles.set(&pk, o);
                        slashed.push(json!(pk));
                    }
                }
            }
        }
        if bond > 0 {
            let to = if ruling == "dismiss" { self.sink() } else { vstr(&d, "disputer") };
            self.transfer(&to, bond);
        }
        json!({"ruled": ruling, "slashed": slashed,
               "bondTo": if ruling == "dismiss" { self.sink() } else { vstr(&d, "disputer") }})
    }

    #[allow(non_snake_case)]
    pub fn setArbitrator(&mut self, account: String) -> bool {
        assert!(env::predecessor_account_id() == env::current_account_id(),
            "only contract account sets the arbitrator");
        self.arbitrator = account;
        true
    }

    fn open_disputes(&self, m: &Value) -> Vec<Value> {
        vobj(m, "disputes").values()
            .filter(|d| vs(d, "status") == Some("open")).cloned().collect()
    }

    // ---- settlement ----

    #[allow(non_snake_case)]
    pub fn release(&mut self, marketId: String, verdictSig: Option<String>,
        oraclePubkey: Option<String>, winningClaimId: Option<Value>,
    ) -> Value {
        let mut m = self.markets.get(&marketId).expect("market not open");
        assert!(vs(&m, "status") == Some(OPEN), "market not open");
        assert!(self.open_disputes(&m).is_empty(), "open dispute freezes release");
        let bag = self.bag(&marketId).expect("no claims");
        let order_len = bag.get("order").unwrap().as_array().unwrap().len();
        assert!(order_len > 0, "no claims");

        let signer = env::signer_account_id().to_string();
        let payer = vstr(&m, "payer");
        let is_payer = signer == payer;

        let winner = if let Some(w) = winningClaimId.filter(|x| !x.is_null()) {
            self.claim(&marketId, &id_of(&w))
        } else if is_payer {
            self.first_pending(&marketId)
        } else {
            None
        }.expect("winning claim not pending");
        assert!(vs(&winner, "status") == Some("pending"), "winning claim not pending");
        let winner_id = vstr(&winner, "claimId");

        // Inline oracle vote (quorum=1 fast path).
        if let Some(pk) = oraclePubkey.as_ref() {
            if let Some(mut oracle) = self.oracles.get(pk) {
                let blind = m.get("commitReveal").and_then(|x| x.as_bool()) == Some(true);
                if !is_payer
                    && oracle.get("active").and_then(|x| x.as_bool()) == Some(true)
                    && !blind
                    && env::predecessor_account_id().to_string() == vstr(&oracle, "owner")
                {
                    let mut verdicts = vobj(&m, "verdicts");
                    let prior = verdicts.get(pk).and_then(|p| vs(p, "verdict")).map(|s| s.to_string());
                    verdicts.insert(pk.clone(), json!({
                        "claimId": winner_id, "verdict": "accept", "conf": Value::Null,
                        "sig": verdictSig, "ts": env::block_timestamp().to_string(),
                    }));
                    set(&mut m, "verdicts", Value::Object(verdicts));
                    if prior.as_deref() != Some("accept") {
                        let n = vnum(&oracle, "verdicts").unwrap_or(0) + 1;
                        set(&mut oracle, "verdicts", json!(n));
                        self.oracles.set(pk, oracle);
                    }
                }
            }
        }
        let votes = self.accept_votes(&marketId, &winner_id);
        let quorum = vnum(&m, "oracleQuorumM").unwrap_or(DEFAULT_QUORUM_M);
        assert!(is_payer || votes >= quorum, "release needs payer or quorum oracle accept votes");
        if !is_payer {
            assert!(winner.get("attested").and_then(|x| x.as_bool()) == Some(true),
                "oracle quorum can only settle attested claims");
        }

        let locked = vbig(&m, "locked");
        let fee = locked * FEE_BPS / 10000;
        let platform_cut = locked * vbig(&m, "platformBps") / 10000;
        // Adjudication is paid by the claimant: when a jury's accepts
        // carried the settlement, JUROR_SHARE_BPS of the fee amount comes
        // out of the winner's net and goes to those seat owners. Payer-
        // signed releases (no jury) charge nothing extra.
        let juror_pool = if self.jurors_of(&m, &winner_id).is_empty() { 0 }
            else { fee * JUROR_SHARE_BPS / 10000 };
        let net = locked - fee - platform_cut - juror_pool;
        set(&mut m, "status", json!(PAID));
        set(&mut m, "paidTo", json!(vstr(&winner, "claimant")));
        set(&mut m, "claimHash", json!(vstr(&winner, "claimHash")));
        set(&mut m, "winningClaimId", json!(winner_id));
        if let Some(h) = m.get("payToHat").cloned() {
            if !h.is_null() { set(&mut m, "payoutHatId", h); }
        }
        let mut w = winner.clone();
        set(&mut w, "status", json!("won"));
        self.save_claim(&w);
        self.markets.set(&marketId, m.clone());
        self.payout(&m, &vstr(&winner, "claimant"), net);
        self.pay_fees(&m, &winner, fee, platform_cut, juror_pool);
        self.maybe_bridge_out(&m, &winner);
        json!({"paid": vstr(&winner, "claimant"), "net": net.to_string(),
               "fee": fee.to_string(), "platformCut": platform_cut.to_string(),
               "jurorPool": juror_pool.to_string(),
               "claimHash": vstr(&m, "claimHash"),
               "winningClaimId": winner_id, "losers": order_len as i64 - 1})
    }

    // ---- views ----

    #[allow(non_snake_case)]
    pub fn getMarket(&self, marketId: String) -> Option<Value> {
        self.markets.get(&marketId)
    }

    #[allow(non_snake_case)]
    pub fn getDisputes(&self, marketId: String) -> Value {
        match self.markets.get(&marketId) {
            Some(m) => Value::Array(vobj(&m, "disputes").values().cloned().collect()),
            None => json!([]),
        }
    }

    #[allow(non_snake_case)]
    pub fn getClaim(&self, marketId: String) -> Option<Value> {
        self.first_pending(&marketId)
    }

    #[allow(non_snake_case)]
    pub fn getClaims(&self, marketId: String, from: Option<i64>, limit: Option<i64>) -> Value {
        let bag = match self.bag(&marketId) {
            Some(b) => b, None => return json!({"claims": [], "total": 0}),
        };
        let m = self.markets.get(&marketId);
        let f = from.unwrap_or(0).max(0) as usize;
        let l = limit.unwrap_or(CLAIM_PAGE).clamp(0, 200) as usize;
        let (mut pending, mut resolved) = (Vec::new(), Vec::new());
        for id in bag.get("order").unwrap().as_array().unwrap() {
            let cid = id_of(id);
            if let Some(c) = self.claim(&marketId, &cid) {
                let r = self.resolved(m.as_ref(), c);
                if vs(&r, "status") == Some("pending") { pending.push(r) } else { resolved.push(r) }
            }
        }
        let total = pending.len() + resolved.len();
        let pend = pending.len();
        let all: Vec<Value> = pending.into_iter().chain(resolved).skip(f).take(l).collect();
        json!({"claims": all, "total": total, "pending": pend})
    }

    #[allow(non_snake_case)]
    pub fn getOracle(&self, pubkey: String) -> Option<Value> {
        self.oracles.get(&pubkey)
    }

    #[allow(non_snake_case)]
    pub fn listOracles(&self) -> Value {
        let out: Vec<Value> = self.oracle_keys.iter().filter_map(|pk| {
            self.oracles.get(pk).map(|o| {
                let mut r = Map::new();
                r.insert("pubkey".into(), json!(pk));
                if let Some(obj) = o.as_object() { r.extend(obj.clone()); }
                Value::Object(r)
            })
        }).filter(|o| o.get("owner").is_some()).collect();
        Value::Array(out)
    }

    #[allow(non_snake_case)]
    pub fn getVerdicts(&self, marketId: String) -> Option<Value> {
        let m = self.markets.get(&marketId)?;
        let mut tally = Map::new();
        for v in vobj(&m, "verdicts").values() {
            if vs(v, "verdict") == Some("accept") {
                let cid = vstr(v, "claimId");
                let n = tally.get(&cid).and_then(|x| x.as_i64()).unwrap_or(0) + 1;
                tally.insert(cid, json!(n));
            }
        }
        Some(json!({
            "quorumM": vnum(&m, "oracleQuorumM").unwrap_or(DEFAULT_QUORUM_M),
            "allowlist": m.get("oracleAllowlist").cloned().unwrap_or(Value::Null),
            "votes": m.get("verdicts").cloned().unwrap_or(json!({})),
            "acceptTally": tally,
        }))
    }

    #[allow(non_snake_case)]
    pub fn listOpen(&self, from: Option<i64>, limit: Option<i64>) -> Value {
        let f = from.unwrap_or(0).max(0) as usize;
        let l = limit.unwrap_or(CLAIM_PAGE).clamp(0, 200) as usize;
        let open: Vec<Value> = self.market_ids.iter().filter_map(|id| {
            self.markets.get(id).filter(|m| vs(m, "status") == Some(OPEN))
        }).skip(f).take(l).collect();
        Value::Array(open)
    }

    #[allow(non_snake_case)]
    pub fn listAll(&self, from: Option<i64>, limit: Option<i64>) -> Value {
        let f = from.unwrap_or(0).max(0) as usize;
        let l = limit.unwrap_or(CLAIM_PAGE).clamp(0, 200) as usize;
        let out: Vec<Value> = self.market_ids.iter().skip(f).take(l)
            .filter_map(|id| self.markets.get(id)).collect();
        Value::Array(out)
    }

    // ---- internal ----

    fn resolved(&self, m: Option<&Value>, c: Value) -> Value {
        if let Some(m) = m {
            if vs(&c, "status") == Some("pending") && vs(m, "status") == Some(PAID)
                && vstr(m, "winningClaimId") != vstr(&c, "claimId") {
                let mut r = c.clone();
                set(&mut r, "status", json!("outcompeted"));
                return r;
            }
        }
        c
    }

    fn transfer(&self, to: &str, amount: u128) {
        if amount == 0 || to.is_empty() { return; }
        let _ = Promise::new(acct(to)).transfer(NearToken::from_yoctonear(amount));
    }

    /// Settlement leg in the escrowed asset; native NEAR = transfer,
    /// FT/mt = storage_deposit + transfer call on the token contract.
    fn payout(&self, m: &Value, to: &str, amount: u128) {
        if amount == 0 { return; }
        let token = vstr(m, "token");
        if token.is_empty() { self.transfer(to, amount); return; }
        let token_id = vstr(m, "tokenId");
        let args = if token_id.is_empty() {
            json!({"receiver_id": to, "amount": amount.to_string()})
        } else {
            json!({"receiver_id": to, "token_id": token_id, "amount": amount.to_string()})
        };
        let _ = Promise::new(acct_id(&token))
            .function_call(
                "storage_deposit".to_string(),
                serde_json::to_vec(&json!({"account_id": to, "registration_only": true})).unwrap(),
                NearToken::from_yoctonear(STORAGE_DEPOSIT_YOCTO),
                Gas::from_tgas(10),
            )
            .function_call(
                if token_id.is_empty() { "ft_transfer".to_string() } else { "mt_transfer".to_string() },
                serde_json::to_vec(&args).unwrap(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(30),
            );
    }

    /// Owner accounts of seats whose accept verdict backed the winner —
    /// the jury that did the adjudication work.
    fn jurors_of(&self, m: &Value, winner_cid: &str) -> Vec<String> {
        vobj(m, "verdicts").iter()
            .filter(|(_, v)| vs(v, "verdict") == Some("accept") && vs(v, "claimId") == Some(winner_cid))
            .filter_map(|(pk, _)| self.oracles.get(pk))
            .map(|o| vstr(&o, "owner"))
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// Settlement fees. The juror pool is funded by the CLAIMANT (deducted
    /// from net before payout) — adjudication is a cost of claiming, not a
    /// protocol expense. The sink receives the full protocol fee; platform
    /// gets its cut. Dust/rounding stays in the claimant's net.
    fn pay_fees(&self, m: &Value, winner: &Value, fee: u128, platform_cut: u128, juror_pool: u128) {
        let jurors = self.jurors_of(m, &vstr(winner, "claimId"));
        if !jurors.is_empty() && juror_pool > 0 {
            let each = juror_pool / jurors.len() as u128;
            for owner in &jurors {
                self.payout(m, owner, each);
            }
        }
        if fee > 0 { let s = self.sink(); self.payout(m, &s, fee); }
        if platform_cut > 0 {
            let to = vs(m, "platformTo").map(|s| s.to_string()).unwrap_or_else(|| self.sink());
            self.payout(m, &to, platform_cut);
        }
    }

    fn maybe_bridge_out(&self, m: &Value, winner: &Value) {
        let token_id = vstr(m, "tokenId");
        if token_id.is_empty() || winner.get("payoutIntent").is_none()
            || winner.get("payoutIntent").unwrap().is_null() { return; }
        let _ = Promise::new(acct_id(&vstr(m, "token"))).function_call(
            "execute_intents".to_string(),
            serde_json::to_vec(&json!({"signed": winner.get("payoutIntent").unwrap()})).unwrap(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(60),
        );
    }
}

fn jstr(m: &Map<String, Value>, k: &str) -> Option<String> {
    m.get(k).and_then(|x| x.as_str()).map(|s| s.to_string())
}// ---- near dispatch layer ----
// The contract struct itself carries no managed state: entry points are
// static (no `self`), so near-sdk never auto-reads/writes "STATE". Each
// method loads the near-sdk-js JSON root explicitly and mutating methods
// save it back — preserving both the wire format and view-no-write
// semantics of the JS contract.

#[near(contract_state)]
pub struct Market {
    root: Root,
}

/// Fresh deploys start from an empty root — same fields the JS constructor
/// established (collections with their prefixes, id arrays, nextId 1).
impl Default for Market {
    fn default() -> Self {
        Market { root: Root::from_root(&Value::Null) }
    }
}

#[near]
impl Market {
    #[payable]
    #[allow(non_snake_case)]
    pub fn createMarket(&mut self, specHash: Option<String>, spec: Option<String>,
        deadline: Option<Value>, acceptanceRule: Option<String>, payToHat: Option<String>,
        claimTtlNs: Option<Value>, acceptanceHash: Option<String>, platformBps: Option<i64>,
        platformTo: Option<String>, oracleQuorumM: Option<i64>, oracleAllowlist: Option<Vec<String>>,
        arbitrator: Option<String>, disputeBondYocto: Option<String>, commitReveal: Option<bool>) -> String {
        let out = self.root.createMarket(specHash, spec, deadline, acceptanceRule, payToHat,
            claimTtlNs, acceptanceHash, platformBps, platformTo, oracleQuorumM, oracleAllowlist,
            arbitrator, disputeBondYocto, commitReveal);
        out
    }

    #[allow(non_snake_case)]
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: String, msg: String) -> String {
        self.root.ft_on_transfer(sender_id, amount, msg)
    }

    #[allow(non_snake_case)]
    pub fn mt_on_transfer(&mut self, sender_id: AccountId, token_ids: Vec<String>, amounts: Vec<String>, msg: String) -> Value {
        self.root.mt_on_transfer(sender_id, token_ids, amounts, msg)
    }

    #[allow(non_snake_case)]
    pub fn refund(&mut self, marketId: String) -> Value {
        self.root.refund(marketId)
    }

    #[payable]
    #[allow(non_snake_case)]
    pub fn registerOracle(&mut self, pubkey: String) -> bool {
        self.root.registerOracle(pubkey)
    }

    #[payable]
    #[allow(non_snake_case)]
    pub fn bondOracle(&mut self, oraclePubkey: String) -> Value {
        self.root.bondOracle(oraclePubkey)
    }

    #[allow(non_snake_case)]
    pub fn deactivateOracle(&mut self, pubkey: String) -> bool {
        self.root.deactivateOracle(pubkey)
    }

    #[payable]
    #[allow(non_snake_case)]
    pub fn submitVerdict(&mut self, marketId: String, claimId: Value, verdict: String,
        conf: Option<i64>, oraclePubkey: String, verdictSig: Option<String>) -> Value {
        self.root.submitVerdict(marketId, claimId, verdict, conf, oraclePubkey, verdictSig)
    }

    #[allow(non_snake_case)]
    pub fn commitVerdict(&mut self, marketId: String, oraclePubkey: String, commit: String) -> Value {
        self.root.commitVerdict(marketId, oraclePubkey, commit)
    }

    #[payable]
    #[allow(non_snake_case)]
    pub fn revealVerdict(&mut self, marketId: String, claimId: Value, verdict: String,
        conf: Option<i64>, salt: Option<String>, verdictSig: Option<String>, oraclePubkey: String) -> Value {
        self.root.revealVerdict(marketId, claimId, verdict, conf, salt, verdictSig, oraclePubkey)
    }

    #[payable]
    #[allow(non_snake_case, clippy::too_many_arguments)]
    pub fn shipClaim(&mut self, marketId: String, claimHash: Option<String>, actor: Option<String>,
        commits: Option<Value>, evidence: Option<Value>, claimant: Option<String>,
        forgeId: Option<String>, forgeUserId: Option<String>, relayer: Option<String>,
        attested: Option<bool>, payoutIntent: Option<Value>) -> String {
        self.root.shipClaim(marketId, claimHash, actor, commits, evidence, claimant,
            forgeId, forgeUserId, relayer, attested, payoutIntent)
    }

    #[allow(non_snake_case)]
    pub fn withdrawClaim(&mut self, marketId: String, claimId: Value) -> bool {
        self.root.withdrawClaim(marketId, claimId)
    }

    #[allow(non_snake_case)]
    pub fn cleanupExpired(&mut self, marketId: String, from: Option<i64>, limit: Option<i64>) -> Value {
        self.root.cleanupExpired(marketId, from, limit)
    }

    #[allow(non_snake_case)]
    pub fn finalizeLosers(&mut self, marketId: String, from: Option<i64>, limit: Option<i64>) -> Value {
        self.root.finalizeLosers(marketId, from, limit)
    }

    #[allow(non_snake_case)]
    pub fn sweepLegacy(&mut self, field: String, limit: Option<i64>) -> Value {
        self.root.sweepLegacy(field, limit)
    }

    #[payable]
    #[allow(non_snake_case)]
    pub fn dispute(&mut self, marketId: String, claimId: Option<Value>, evidenceCid: Option<String>) -> Value {
        self.root.dispute(marketId, claimId, evidenceCid)
    }

    #[allow(non_snake_case)]
    pub fn resolveDispute(&mut self, marketId: String, claimId: Option<Value>, ruling: String) -> Value {
        self.root.resolveDispute(marketId, claimId, ruling)
    }

    #[allow(non_snake_case)]
    pub fn setArbitrator(&mut self, account: String) -> bool {
        self.root.setArbitrator(account)
    }

    #[allow(non_snake_case)]
    pub fn setFeeSink(&mut self, account: String) -> Value {
        self.root.setFeeSink(account)
    }

    #[allow(non_snake_case)]
    pub fn release(&mut self, marketId: String, verdictSig: Option<String>,
        oraclePubkey: Option<String>, winningClaimId: Option<Value>) -> Value {
        self.root.release(marketId, verdictSig, oraclePubkey, winningClaimId)
    }

    // ---- views: load only, never save ----

    #[allow(non_snake_case)]
    pub fn getConfig(&self) -> Value { self.root.getConfig() }
    #[allow(non_snake_case)]
    pub fn getMarket(&self, marketId: String) -> Option<Value> { self.root.getMarket(marketId) }
    #[allow(non_snake_case)]
    pub fn getDisputes(&self, marketId: String) -> Value { self.root.getDisputes(marketId) }
    #[allow(non_snake_case)]
    pub fn getClaim(&self, marketId: String) -> Option<Value> { self.root.getClaim(marketId) }
    #[allow(non_snake_case)]
    pub fn getClaims(&self, marketId: String, from: Option<i64>, limit: Option<i64>) -> Value {
        self.root.getClaims(marketId, from, limit)
    }
    #[allow(non_snake_case)]
    pub fn getOracle(&self, pubkey: String) -> Option<Value> { self.root.getOracle(pubkey) }
    #[allow(non_snake_case)]
    pub fn listOracles(&self) -> Value { self.root.listOracles() }
    #[allow(non_snake_case)]
    pub fn getVerdicts(&self, marketId: String) -> Option<Value> { self.root.getVerdicts(marketId) }
    #[allow(non_snake_case)]
    pub fn listOpen(&self, from: Option<i64>, limit: Option<i64>) -> Value { self.root.listOpen(from, limit) }
    #[allow(non_snake_case)]
    pub fn listAll(&self, from: Option<i64>, limit: Option<i64>) -> Value { self.root.listAll(from, limit) }
}
