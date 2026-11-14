# widespread-oracle-runner

Run your own adjudication seat — real independence, not our key.

## What a seat does

Scans `listOpen` → adjudicates pending **attested** claims with your own
LLM panel → `submitVerdict` on-chain from YOUR account → `release` when
the market's `oracleQuorumM` accepts align. Owner-account voting means
nobody can forge your seat, and you can't be forged either.

## Setup

```bash
npm install
# a NEAR account with a little balance (testnet faucet / Intents)
export ORACLE_ACCOUNT=you.testnet
export ORACLE_SECRET_KEY=ed25519:<base58>        # near-cli format
export ORACLE_PUBKEY_HEX=<64 hex>                # your seat id — any value, keep it stable
export ORACLE_SEED_HEX=<64 hex ed25519 seed>     # signs off-chain verdict evidence
export ORACLE_X25519_SECRET=<64 hex>             # for spec_sealed adjudication copies
export ORACLE_X25519_PUBKEY=<its 64-hex pubkey>  # funders seal spec copies to this
export NEAR_CONTRACT=wide-mkt-11561.testnet
# your own judge — any OpenAI-compatible endpoint; NEAR AI Cloud = TEE-attested
export JUDGE_API=https://cloud-api.near.ai/v1
export JUDGE_KEY=<api key>
export JUDGE_MODELS=deepseek-ai/DeepSeek-V4.1-Flash-1017,meta-llama/Meta-Llama-3.3-70B-Instruct
```

```bash
node run.mjs register   # one-time: claim the seat on-chain
node run.mjs run        # poll + adjudicate forever
node run.mjs once       # single cycle (cron-friendly)
```

## Collective-sealed specs (spec_sealed)

A funder running a fully private market seals spec copies to declared
`adjudicator_x25519_pubkeys` — if your pubkey is listed, the sealed copy
is on the public declaration record (`/api/declarations/{hash}`,
`bounty.spec_sealed_adjudicators_b64[your_pubkey]`). You decrypt
locally, verify it binds `spec_hash` (a funder can't bait you with a
different spec), judge the worker's `ciphertext_adjudicators_b64` copy
the same way, and vote. The bridge never holds plaintext you can read —
that's the point.

## Honest notes

- Your NEAR account needs gas money; votes are transactions.
- `oracleAllowlist` markets only accept votes from listed seats — the
  funder's jury selection. Unlisted = open jury.
- Open disputes freeze markets; the runner skips them.
- Your judge choice is yours — publish your model list if you want
  jurors to audit your seat's determinism.
