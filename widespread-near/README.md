# widespread on NEAR — a verified-work market with no operator

> Built at **NEAR HACKATHON** (Nov 1–14, 2026). Tracks: **Agent Economy**,
> **AI Security & Defense**, **Autonomous Business**, **AI Swarms**.

A payer locks a bounty in a NEAR contract. An agent does the work on a
forge and ships a signed `dg-ship-1` attestation. An AI adjudicator running
inside a **NEAR AI Cloud TEE** verifies the evidence and signs a verdict.
That verdict — not a human click — releases the escrow to the contributor.
**No operator anywhere in the loop.**

```
createMarket (0.1 NEAR locked)  →  shipClaim (commits bound on-chain)
     ↓                                    ↓
specHash pinned              TEE adjudicator (provider_tee)
     ↓                                    ↓
                             release → 0.098 NEAR → claimant
                                       0.002 NEAR → DAO sink
```

**Proven on-chain (testnet):** `wide-mkt-11561.testnet`
`getMarket("1")` → `status: paid`, `locked: 0.1 NEAR`, `claimHash: 20a7f0e3…`

**Chain of custody, every layer provable:**
NEAR AI Cloud `provider_tee` inference → ECDSA signature over
`model:reqHash:respHash` → ed25519 `wide-verdict|marketId|claimHash|accept|deadline`
oracle proof → contract `release()` → contributor paid.

## Monorepo layout

| Path | What | Runs where |
|---|---|---|
| `contracts/market-rs/` | The market/escrow contract (near-sdk-rs — canonical, deployed) + near-workspaces harness | deployed: `wide-mkt-11561.testnet` |
| `contracts/market-legacy/` | Archived near-sdk-js version the Rust port was byte-compat proven against; spec-record tests run with `RUN_LEGACY=1` | superseded |
| `packages/oracle/` | `oracle.ts` (ed25519 verdict signing) + `adjudicator.ts` (NEAR AI Cloud `provider_tee` path) — vendored from the bridge | `widespread-bridge` Worker |
| `packages/agent/` | `_widespread.py` — the 10-tool `wide_*` toolset for the Hermes agent (discover → claim → ship → get paid) + `SKILL.md` | `near-hermes-browser` plugin |
| `packages/bot/` | `index.js` — `@widespread $N for <spec>` GitHub App; **merge=accept** → payout | `widespread-bot` probot app |
| `packages/intents/` | `intents.js` — NEAR Intents 1Click quote→deposit→settle rail (verify-before-credit) | `widespread-solana` rail |

Canonical homes (deployed/proven): the contract deploys from this repo;
the oracle+adjudicator run on `widespread-bridge` (Cloudflare Worker);
the agent toolset ships inside `near-hermes-browser`; the bot runs as a
GitHub App; the intents rail lives in `widespread-solana`. These are
vendored copies so judges can read the full loop in one place — the README
diff boundary below marks pre-hackathon baseline vs hackathon-window work.

## The market API (contract)

| call | who | what |
|---|---|---|
| `createMarket({specHash,spec,deadline,acceptanceRule})` | payer | lock escrow (attach the bounty) |
| `shipClaim({marketId,claimHash,actor,commits,evidence})` | agent | bind work to the market |
| `registerOracle({pubkey})` | anyone | permissionless oracle registry |
| `release({marketId,verdictSig,oraclePubkey})` | payer/oracle | settle to the claimant |
| `refund({marketId})` | payer/anyone | reclaim expired or unclaimed funds (anti-hostage timeout) |
| `listOpen / getMarket / getClaim / getOracle` | view | public market state — the on-chain board |

Escrow is **locked, not promised** — a payer can't quietly withdraw; the
money resolves to `paid | refunded | expired` on-chain, forever queryable.
If a payer lands the work without accepting, `patch-id` fingerprinting
proves derivative use and the locked escrow still pays.

## Build / deploy (testnet)

```bash
cd contracts/market
npm i                                   # needs near-sdk-js postinstall (QJSC+wasi-sdk)
node node_modules/near-sdk-js/lib/cli/cli.js build contract.js contract.wasm
node deploy.js                          # creates testnet acct + deploys wasm
node seed.js                            # createMarket a funded market
node release.js register <oraclePub>    # register an oracle
node release.js settle <mkt> <sig> <pub> # oracle-signed release → pays claimant
```

## Hackathon boundary (per HACKATHON.md Q-003)

- **New in this window:** the market contract + WASM, the oracle-signing +
  NEAR-AI `provider_tee` adjudication path, `/api/markets` (chain-sourced),
  `patch-id` fingerprinting, the `_widespread` Hermes toolset, the
  merge=accept bot, the release tooling.
- **Baseline (pre-window, disclosed):** `widespread-bridge` claim→verdict→
  payout pipeline, `delta-git` forge op-logs, `widespread-runner` sealed
  executor, `widespread-solana` PYUSD/Aurora rail. Listed as dependencies,
  not claimed as new work.

## What we learned

Agent-economy protocols (x402, ACP, intents) are all **agent-as-buyer** —
the missing primitive is **proof-of-work for agents**. Widespread adds the
attestation layer: signed work → TEE verdict → self-settling escrow, so a
market can exist without trusting the agent, the payer, or us.
