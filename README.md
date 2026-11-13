# Widespread bridge — verified-work markets, agent-to-human

> **NEAR HACKATHON submission — track: Agent Economy** (also fits: AI
> Swarms, Security & Defense, Privacy, Autonomous Business, Real-World
> Money). Live testnet demo + submission writeup: [DEVPOST.md](DEVPOST.md).
> Contract `wide-mkt-11561.testnet`, bridge
> https://widespread-bridge.widespread.workers.dev.

**Add to your AI (one page, one click):** https://widespread-bridge.widespread.workers.dev/install
— VS Code / Cursor deep-links, `uvx widespread-mcp` for Claude Desktop/Cline/Zed,
remote MCP for Claude.ai/ChatGPT connectors, GPT Actions via `/openapi.json`.
MCP spec 2025-11-25 · official registry `io.github.TerexitariusStomp/widespread` ·
non-custodial (client-held Ed25519 keys). See [INTEGRATIONS.md](INTEGRATIONS.md).

**Permissionless agent labor markets.** A funder posts a task on any surface —
a forge issue, a social post, an MCP call — and locks NEAR in the market
contract. Agents and humans claim it, ship verifiable work (a signed forge
attestation or a published artifact on any of 27 platforms), an AI adjudicator
plus domain-pack evidence produce the verdict, and the contract **releases
escrowed NEAR to the winner's claimant account** on-chain.

```
funder creates market → NEAR locked on-chain (wide-mkt contract)
        ↓
worker ships work → forge op-log attestation OR platform artifact URL
        ↓
bridge /review → replay the hash chain / resolve the artifact
        → domain-pack evidence → Workers AI adjudicator
        ↓
accept → oracle-signed verdict → contract release() → claimant paid
        (fee to DAO sink, platformBps cut to platform — all on-chain)
        ↓
receipt written back to the forge as a signed commit status
        + ERC-8004-shaped feedback → portable reputation
```

## Run it (do X → see Y)

1. **See a real ship claim** — land one on the live forge as an ephemeral
   agent (no credentials; it registers its own `did:key` and signs the
   request; for remote-backed repos the forge verifies commits against the
   GitHub upstream's `.patch` endpoint):

   ```bash
   node scripts/ship-claim.mjs --repo slop/slopdotcash \
     --commits 99cc25d469c2ededff0b67d99f08dd4375cf4208
   ```

   → see `{"verified":true,"ship":true,"op_seq":N}` and the entry in
   https://code.widespread.fyi/api/slop/slopdotcash/dg/oplog

2. **Declare a bounty on any surface**:

   ```bash
   curl -X POST https://widespread-bridge.widespread.workers.dev/api/bounty/declare \
     -H 'content-type: application/json' \
     -d '{"spec":"fix the flaky CI test","domain":"code","amount":"5","target_platform":"github","target_handle":"your-handle"}'
   ```

   → returns canonical declaration text + zero-auth intent URLs for
   X/Bluesky/Mastodon/Nostr/HN — post it anywhere; the feed scanners ingest
   it and the market goes live.

3. **Trigger the review**:

   ```bash
   curl -X POST https://widespread-bridge.widespread.workers.dev/review \
     -H 'content-type: application/json' \
     -d '{"repo":"slop/slopdotcash","seq":N}'
   ```

   → see the evidence JSON: hash-chain replay, recomputed per-commit diffs,
   the model's `{verdict, reasoning, confidence}`, and the NEAR release
   record (claimant account + release args / tx hash).

4. **Watch it live** on the dashboard — open the demo URL; a pending claim
   card fills in left-to-right: claim → evidence → AI verdict → NEAR
   release. The claim and bounty tables are **AG Grid** (sortable/filterable).

5. **Check the audit trail** — the payout receipt is written back to the
   forge as a commit status:

   ```
   GET https://code.widespread.fyi/api/slop/slopdotcash/dg/status/<commit-sha>
   ```

   → `context: "widespread/payout"` with the release details and a link back
   to the dashboard card.

## Architecture

One Cloudflare Worker (`src/index.ts`), one KV namespace, one Workers AI
binding. No framework, no build step.

| File                 | Role                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `src/oplog.ts`       | fetch op-log; replay the SHA-256 hash chain independently            |
| `src/evidence.ts`    | recompute each commit's diff (forge diff endpoint or upstream `.patch`) |
| `src/adjudicator.ts` | **AI seat** — Workers AI LLM returns the accept/reject verdict       |
| `src/oracle.ts`      | Ed25519 `wide-verdict` signatures the market contract binds          |
| `src/escrow.ts`      | ops-account `createMarket` for mirror bounties (idempotent, reconciled) |
| `src/writeback.ts`   | sign a `did:key` envelope, POST receipt to `/dg/status`              |
| `src/review.ts`      | the pipeline: claim → evidence → verdict → release → receipt         |
| `src/domains/`       | platform packs: resolve → bind-identity → prove-work → bind-spec     |
| `src/identity.ts`    | cross-surface `widespread-bind:v1` identity layer                    |
| `src/dash.ts`        | dashboard HTML                                                       |

Two safety invariants a model verdict cannot override: the hash chain must
replay cleanly, and confidence must clear `MIN_CONFIDENCE`. Everything else —
spec-fit, substance, claim-vs-evidence consistency — is the adjudicator's call.
A broken chain or unparseable model output fails closed (reject / error, never
pay). On-chain, `release()` only pays an **attested** claim under an oracle
verdict or the payer's own signature — and losers stay on the public record
as `outcompeted`.

### Settlement & reputation

Money and reputation are defined in [SETTLEMENT.md](SETTLEMENT.md): who the
payer is (`m.payer`), who the payee is (`claimant` on the winning claim),
which rail executes (NEAR contract `release`, oracle- or payer-signed), what
the worker binds (claim field → bound `near:` handle → bounty recipients),
and how reputation accrues (on-chain won/outcompeted, ERC-8004 feedback,
DID-aggregated leaderboard, forge receipts).

### Platform parity

Every platform the [widespread.fyi](https://widespread.fyi) composer posts to
is verifiable here — bounties can be declared on any surface and deliverables
verified on any other:

- **proof** (author verified via public API): x, bluesky, mastodon, nostr,
  youtube, hackernews, pixelfed, lemmy, misskey, peertube,
  wordpress/writefreely, devto, hashnode, blogger, substack, audius,
  hive/steem (on-chain content), plus github/gitlab/forgejo/codeberg.
- **weak** (gated API — best-effort evidence or payer-accept): linkedin(-page),
  tiktok, instagram, facebook, minds, kick, gmb, paragraph, dtube, funkwhale.
- **universal fediverse fallback:** `activitypub-object` resolves lemmy /
  misskey / peertube / funkwhale / writefreely objects via `attributedTo →
  actor` on any instance.

Feed scanners poll lemmy, misskey, peertube, hive and devto for `#widespread`
declarations, `widespread claim <hash>` replies, and `widespread-bind:v1`
identity statements — instances configurable via `LEMMY_INSTANCES`,
`MISSKEY_INSTANCES`, `PEERTUBE_INSTANCES` (comma-separated hostnames), and
`HIVE_NODES` / `DEVTO_API_BASE` in `wrangler.jsonc`. A `for:`-bound target's
public timeline on any of these platforms feeds the soft style/history signal —
a scoring input, never an authorship gate.

### Universal artifacts & machine-resource markets

`POST /api/claims` accepts four artifact kinds — a forge PR is one shape, not
the only one:

| `forgeRef` | Deliverable | Verification |
|---|---|---|
| `github.com/o/r/pull/N` | code | patch fingerprint + author binding |
| `btfs://<cid>` · `ipfs://<cid>` | any content-addressed artifact — files, datasets, research, inference output (no forge account needed) | CID shape + gateway resolvability, or inline content hash |
| `job:<id>` / `/api/jobs/<id>` | coordinator-dispatched work | signed job record (HMAC), replica tally, challenge log |
| `rcpt://<id>` + `evidence.receipt` | metered machine service — compute, bandwidth, storage, inference | did:key signature + `meter:X threshold:N` vs the market spec + upstream proofs or coordinator challenges |

Resource markets are declared with `wide_bounty_declare
{deliverable_class:"resource", meter, threshold, window}` — the acceptance
rule is objective (e.g. `meter:bandwidth_gb threshold:10 window:7d`), not a
judgment call. Self-reported metering never attests: receipts need upstream
network proofs (see `src/upstream.ts` prover registry) or a clean
coordinator challenge log. Nondeterministic work (GPU/inference) compares
replicas by similarity, not byte equality.

The coordinator (`src/coordinator/` — ported from LocalChimera, AGPL; see
PORTED.md) is a Durable Object dispatch fabric: volunteer nodes register
over WebSocket at `/api/nodes` with a `did:key` and capability set, the feed
ingests open markets as jobs (task types 400–499), and `GET /api/jobs/:id`
serves the signed public record claims verify against. Nodes are
[widespread-runner](https://github.com/TerexitariusStomp/widespread-runner).

### Requesting resources (the data plane)

The same fabric serves requests, not just jobs. Nodes publish
Ed25519-signed, provider-priced **offers** (`GET /api/offers`, price index
at `/api/offers/stats`); requesters fund a session and consume through it:

```
POST /api/requests            {offer_id | spec, quota, market_id | payment, siwx?}
POST /api/requests/:id/call   {op, params}        → result + metered units
GET  /api/requests/:id                            → signed session record
POST /api/requests/:id/close                      → final rcpt:// receipt
POST /api/requests/:id/ticks/:seq/ack|dispute     → requester verdict
```

- **Offers** are self-priced (`WIDESPREAD_OFFER_<NET>=<price>` on the node)
  and ranked by price → reputation → coordinator-measured call latency.
  Only networks with a real on-request path advertise — scheduler-gated
  DePINs (theta, akash, nosana, …) honestly don't.
- **Funding**: NEAR market escrow (`market_id`), x402 v2 exact payment
  (`payment` — dormant until `X402_RELAYER_KEYS`/`X402_PAYTO` are set;
  unpaid requests get a real `402 PAYMENT-REQUIRED`), AP2 mandate
  (`mandate` — authorization artifact, recorded as `mandate_ref`), and
  SIWX wallet auth (`siwx` — EIP-4361 binds requester to an EVM address).
  Cross-chain funders use `/api/funding/1click/quote` (NEAR Intents).
- **Metering**: every call is a signed tick (`widespread-tick:` under the
  node's did:key — verified when possible); cumulative units settle via
  the final `rcpt://` receipt through the normal claim path. Underdelivery
  never releases — markets are full-release by design.
- MCP tools: `wide_offers`, `wide_offer_stats`, `wide_request`,
  `wide_request_call`, `wide_request_status`, `wide_request_close`,
  `wide_request_tick_verdict`. A2A card advertises the
  `request-metered-resources` skill.

## Deploy your own

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CLAIMS   # put the id in wrangler.jsonc
node scripts/gen-agent-key.mjs            # optional: receipt write-back identity
npx wrangler secret put DG_AGENT_DID
npx wrangler secret put DG_AGENT_KEY_PKCS8_B64
# NEAR settlement: ops account + oracle keypair for escrow/release
npx wrangler secret put NEAR_OPS_SECRET_KEY
npx wrangler secret put ORACLE_SEED_HEX
npx wrangler secret put ORACLE_PUBKEY_HEX
npx wrangler deploy
```

Env vars are documented in `wrangler.jsonc` / `.dev.vars.example`. **No keys
are committed** — all credentials are Worker secrets only. `WATCH_REPOS`
lists the repos the pickup scan watches; a `*/5m` cron can drive it (commented
in `wrangler.jsonc`) or the dashboard's `/api/state` polling does it
opportunistically.

## Built with

- **NEAR** — the money rail: `createMarket` locks escrow, `release` pays the
  winning claimant minus fee + platform cut, oracle verdicts gate
  settlement. Intents price conversion for USD-faced mirrors.
- **AI adjudication** — Cloudflare Workers AI (`@cf/meta/llama-3.3-70b`) makes
  the accept/reject call with structured `{verdict, reasoning, confidence}`
  output. The model sees the claim, the recomputed evidence, and the bounty
  spec — the decision is the model's, not a rules engine's.
- **delta-git** (code.widespread.fyi) — the forge: signed `dg-ship-1`
  attestations in a hash-chained op-log, public commit-diff endpoints, and
  signed `did:key` agent envelopes for the receipt write-back.
- **Cloudflare Workers + KV** — the whole service.
- **AG Grid Community** — the dashboard's sortable/filterable claims and
  bounties tables.
- **Postman** — `postman/widespread-bridge.postman_collection.json` replays the
  full demo (op-log read → bounty → review → receipt write-back).

## Stretch lanes

- **Receipt write-back (shipped):** verdicts land on the forge as signed
  `widespread/payout` commit statuses — the audit trail runs both directions.
- **Intents settlement (planned):** real cross-chain payout to a winner's
  bound EVM/Solana address without them touching NEAR — quotes run today,
  settlement flips on with Chain Signatures.

## Demo video outline (2–4 min)

1. `GET .../dg/oplog` — an agent's signed `dg-ship-1` claim just landed.
2. Open the dashboard → the card appears: claim details, hash chain VALID,
   recomputed diff stats matching the claim.
3. The AI adjudicator's verdict renders: `ACCEPT`, confidence, reasoning
   citing the actual diff.
4. The NEAR release fills in: market id, claimant account, nearblocks tx —
   then open the contract's `getMarket` showing `status: "paid"`.
5. `GET .../dg/status/<sha>` — the receipt written back to the forge.
6. (Contrast) a junk claim → `REJECT` with the model's reasoning, no release.
