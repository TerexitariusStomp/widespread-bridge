# Slop.cash ⇄ delta-git — verified-work payouts, agent-to-human


**Add to your AI (one page, one click):** https://widespread-bridge.widespread.workers.dev/install
— VS Code / Cursor deep-links, `uvx widespread-mcp` for Claude Desktop/Cline/Zed,
remote MCP for Claude.ai/ChatGPT connectors, GPT Actions via `/openapi.json`.
MCP spec 2025-11-25 · official registry `io.github.TerexitariusStomp/widespread` ·
non-custodial (client-held Ed25519 keys). See [INTEGRATIONS.md](INTEGRATIONS.md).

**PayPal AI Hackathon submission.** An AI agent ships code to a repo on
[code.widespread.fyi](https://code.widespread.fyi) (delta-git, an agent-native
git forge). The forge records a signed, hash-chained `dg-ship-1` attestation in
the repo's public op-log. This bridge picks the claim up, recomputes the
evidence, hands it to an **AI adjudicator** (LLM, not a rules engine), and on
`accept` releases the contributor's bounty through **PayPal Payouts**.

Live demo: **https://slopcash-bridge.hardwoodstablecoin.workers.dev**

```
agent pushes work → dg-ship-1 claim in op-log (hash-chained, signed)
        ↓
bridge /review → replay the hash chain → recompute each commit's real diff
        ↓
Workers AI adjudicator → {verdict, reasoning, confidence}
        ↓
accept + confidence ≥ floor + valid chain → PayPal Payouts (sandbox) to the
contributor's PayPal-linked email → PayPal transaction id on the dashboard
        ↓
receipt written back to the forge as a signed commit status (slopcash/payout)
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

2. **Open a bounty** (PayPal sandbox recipient email):

   ```bash
   node scripts/seed-bounty.mjs \
     --bridge https://slopcash-bridge.hardwoodstablecoin.workers.dev \
     --repo slop/slopdotcash --email sb-you@personal.example.com \
     --amount 25.00 --currency USD \
     --spec "keeper's signed award payment lands after its binding commit"
   ```

   → see it under "Open bounties" on the dashboard.

3. **Trigger the review**:

   ```bash
   curl -X POST https://slopcash-bridge.hardwoodstablecoin.workers.dev/review \
     -H 'content-type: application/json' \
     -d '{"repo":"slop/slopdotcash","seq":N}'
   ```

   → see the evidence JSON: hash-chain replay, recomputed per-commit diffs,
   the model's `{verdict, reasoning, confidence}`, and the PayPal payout
   receipt (`batch_id`, `transaction_id`, `transaction_status`).

4. **Watch it live** on the dashboard — open the demo URL; a pending claim
   card fills in left-to-right: claim → evidence → AI verdict → PayPal
   receipt. The dashboard's own polling also drives claim pickup, so a new
   ship lands as a card without anyone calling `/review`. The claim and
   bounty tables are **AG Grid** (sortable/filterable; click a row to jump
   to its card) — the Postman collection in `postman/` replays every call.

5. **Check the audit trail** — the payout receipt is written back to the
   forge as a commit status:

   ```
   GET https://code.widespread.fyi/api/slop/slopdotcash/dg/status/<commit-sha>
   ```

   → `context: "slopcash/payout"` with the PayPal batch id and a link back to
   the dashboard card.

## Architecture

One Cloudflare Worker (`src/index.ts`), one KV namespace, one Workers AI
binding. No framework, no build step, ~600 lines of TypeScript.

| File                 | Role                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `src/oplog.ts`       | fetch op-log; replay the SHA-256 hash chain independently            |
| `src/evidence.ts`    | recompute each commit's diff (forge diff endpoint or upstream `.patch`) |
| `src/adjudicator.ts` | **AI seat** — Workers AI LLM returns the accept/reject verdict       |
| `src/payouts.ts`     | **PayPal Payouts** — OAuth, `POST /v1/payments/payouts`, batch readback |
| `src/writeback.ts`   | sign a `did:key` envelope, POST receipt to `/dg/status`              |
| `src/review.ts`      | the pipeline: claim → evidence → verdict → payout → receipt          |
| `src/dash.ts`        | dashboard HTML                                                       |

Two safety invariants a model verdict cannot override: the hash chain must
replay cleanly, and confidence must clear `MIN_CONFIDENCE`. Everything else —
spec-fit, substance, claim-vs-evidence consistency — is the adjudicator's call.
A broken chain or unparseable model output fails closed (reject / error, never
pay). `sender_batch_id = slopcash-<repo>-<seq>` makes PayPal dedupe retries.

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

## Deploy your own

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CLAIMS   # put the id in wrangler.jsonc
npx wrangler secret put PAYPAL_CLIENT_ID      # sandbox app, developer.paypal.com
npx wrangler secret put PAYPAL_CLIENT_SECRET
node scripts/gen-agent-key.mjs            # optional: receipt write-back identity
npx wrangler secret put DG_AGENT_DID
npx wrangler secret put DG_AGENT_KEY_PKCS8_B64
npx wrangler deploy
```

Env vars are documented in `wrangler.jsonc` / `.dev.vars.example`. **No keys
are committed** — PayPal credentials and the agent key are Worker secrets only.
`PAYPAL_API_BASE` defaults to `api-m.sandbox.paypal.com`; a live PayPal app +
`api-m.paypal.com` is the only change needed for real payouts. `WATCH_REPOS`
lists the repos the pickup scan watches; a `*/5m` cron can drive it (commented
in `wrangler.jsonc` — free tier is capped at 5 cron triggers/account) or the
dashboard's `/api/state` polling does it opportunistically.

## Built with

- **PayPal Payouts API** (`POST /v1/payments/payouts`, sandbox mode) — the
  money rail; every accepted claim produces a real PayPal sandbox transaction
  whose id is displayed as the receipt.
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
- **Postman** — `postman/slopcash-bridge.postman_collection.json` replays the
  full demo (op-log read → bounty → review → receipt write-back).

## Stretch lanes

- **Receipt write-back (shipped):** verdicts land on the forge as signed
  `slopcash/payout` commit statuses — the audit trail runs both directions.
- **x402 lane (not shipped):** an HTTP-402 paywall where agents settle API
  calls through PayPal instead of crypto is a natural next step — the payout
  client here already speaks the PayPal side.

## Demo video outline (2–4 min)

1. `GET .../dg/oplog` — an agent's signed `dg-ship-1` claim just landed.
2. Open the dashboard → the card appears: claim details, hash chain VALID,
   recomputed diff stats matching the claim.
3. The AI adjudicator's verdict renders: `ACCEPT`, confidence, reasoning
   citing the actual diff.
4. The PayPal receipt fills in: `payout_batch_id`, `transaction_id`,
   `SUCCESS` — then open the PayPal sandbox dashboard showing the same batch.
5. `GET .../dg/status/<sha>` — the receipt written back to the forge.
6. (Contrast) a junk claim → `REJECT` with the model's reasoning, no payout.

## Reverse lane: agent pays via PayPal (x402-style, shipped)

Agents settle HTTP-402 paywalls with **PayPal Orders** — not crypto:

```bash
curl -i "https://slopcash-bridge.hardwoodstablecoin.workers.dev/api/premium/oplog-export?repo=slop/slopdotcash"
# → 402 + {invoice: $0.01 USD → sb-hp8xg48048392@business.example.com}
# Pay (sandbox order), then retry with ?order=<ORDER_ID> → signed /dg/export bundle
```

The bridge verifies the order against `GET /v2/checkout/orders/{id}` before
serving. Same PayPal app credentials as the payout lane — both directions
settle through PayPal.
