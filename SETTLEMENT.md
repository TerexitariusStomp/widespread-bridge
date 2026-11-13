# Settlement & reputation — the funder → worker graph

How money and reputation move from the individual who posts a task to the
individual who completes it. Single rail: **NEAR**. The bridge never
custodies funds.

## Actors

| Role | Identity | Where it lives |
|---|---|---|
| **Funder** | `m.payer` (NEAR account) · optional `funder_did` / `funder_handle` on declared bounties | `createMarket` signer; declaration metadata |
| **Worker** | `claimant` (NEAR account) on the winning claim · `shippedBy` (relayer, may differ) · `did:key` on forge attestations · bound platform handles | `shipClaim.claimant`; `idbind:` records |
| **Oracle** | registered Ed25519 pubkey on the contract | `oracles[pubkey]` |
| **Platform** | `m.platformTo` (defaults to DAO sink) | `platformBps` of locked funds |

## Money flow (canonical path)

```
1. FUND      funder → createMarket(specHash, spec, deadline, platformBps)
             + deposit → locked on-chain. Non-custodial.
2. DISCOVER  feed scanners → workers see amount, spec, for:, claimant rules
3. CLAIM     worker → shipClaim(marketId, claimHash, claimant)
             free, no deposit, unlimited competition
             claimant = the NEAR account that gets paid
4. VERIFY    bridge → forge attestation replay / domain-pack evidence →
             AI adjudicator → oracle signs wide-verdict (Ed25519)
5. SETTLE    release(marketId, verdictSig, oraclePubkey, winningClaimId)
             gate: payer signature (any claim) OR oracle verdict
             (attested claims only)
             → net = locked − FEE_BPS − platformBps → winner.claimant
             → fee → DAO_SINK · platform cut → m.platformTo
             → losers marked `outcompeted` (public record)
6. RECEIPT   review record + signed forge writeback + ERC-8004 feedback
```

## Payee resolution — who the claimant is

Precedence for fiat-facing payouts (`claimantFor` in `review.ts`):

1. `claim.claimant` — the worker's own signed instruction. Always wins.
2. `bounty.recipients[actor]` — funder-named destination for a specific actor
   (pre-seeded counterparty pools).
3. `bounty.receiver_account` — funder's default claimant (single-receiver pools).

On-chain the precedence is simpler: `shipClaim`'s `claimant` arg IS the payee —
set at claim time by the worker (or a relayer acting for them). A worker can
also bind `near:account.near` to their DID (`sig` tier, ed25519 proof) so the
destination is portable across surfaces — see `/api/identity/bind`.

## Alternative funding paths

| Path | How funding lands | Settlement |
|---|---|---|
| Declared bounty (`decl:`) | label-only until someone escrows | same `release` once funded; `warnings` flag unfunded targets |
| Mirror bounty | `POST /api/mirrors/escrow` → ops converts USD→NEAR at Intents price → `createMarket` | same `release`; `platformBps` = mirror cut |
| KV-registry bounty | `receiver_account`/`recipients` seeded by ops | release args emitted on accept (`payout.note`) |
| NEAR Intents (planned) | — | swap released NEAR → winner's bound EVM/Solana address (Chain Signatures) |

## Reputation flow

| Signal | Where it accrues | Public? |
|---|---|---|
| `won` / `outcompeted` claim statuses | on-chain `getClaims(marketId)` | yes — chain |
| `paidTo`, `claimHash`, `winningClaimId` | `getMarket(marketId)` | yes — chain |
| ERC-8004-shaped feedback (grounded in claim hash) | `rep8004For` per settled review | yes — exportable |
| Aggregated accepts/rejects/earned | `GET /api/leaderboard` — all bound handles collapse onto the DID | yes |
| Forge receipts | signed `slopcash/payout` commit status | yes |
| Oracle track record | `oracles[pubkey].verdicts` counter | yes — chain |
| Funder behavior | `m.payer` + market status history (settled vs refunded) — queryable on-chain, not yet aggregated into a funder score | yes — chain |

Reputation is **portable by construction**: a DID binds handles on every
platform (`widespread-bind:v1`), and the leaderboard/rep records collapse all
bound surfaces onto the DID — rep earned on a forge counts for social work
and vice versa.

## Invariants

1. **Worker sovereignty**: the worker's own claim instruction (`claimant` /
   `claim.claimant`) picks the destination; funder defaults never override it.
2. **Verdict-gated release**: contract `release` requires the payer's
   signature or an oracle verdict on an *attested* claim — raw spam can never
   settle.
3. **No double-pay**: same-claim re-review reuses the settlement record;
   mirror payouts queue once (`pending_ops` is terminal until a tx hash);
   escrow reconciliation matches specHash before any rebroadcast.
4. **Timeout safety**: payer refunds only when no pending claims; anyone
   reaps expired claims — a payer can't hostage a market.
5. **Non-custodial**: the bridge holds no worker or funder funds; escrow
   lives in the contract, keys live with signers.
