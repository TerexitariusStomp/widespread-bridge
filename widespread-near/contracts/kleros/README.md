# Kleros rail — human-court appeal for NEAR escrow markets

`WidespreadArbitrable.sol` binds a NEAR dispute to a Kleros court:

1. On NEAR, a bonded `dispute` freezes `release`/`refund` (shipped — D4).
2. Anyone opens a Kleros dispute here bound to the same
   `marketId`/`claimId` — pays the arbitration cost (juror fees), submits
   evidence URIs (the bridge's `/api/disputes/bundle`, pinned to IPFS).
3. Kleros jurors rule. `rule()` callback stores the ruling.
4. A relayer watches `Ruling` events / polls `nearRuling(disputeID)` and
   calls `resolveDispute({marketId, claimId, ruling})` on NEAR from the
   market's `arbitrator` account — `kleros-proxy.*` recommended.

## Deploy (Arbitrum Sepolia testnet)

```bash
# Kleros arbitrator on Arb Sepolia:
#   0xD08Ab99480d02E10B092ABA53094E8a1D8d9102F (KlerosLiquid, verify on
#   https://docs.kleros.io before trusting any address)
npx hardhat run deploy.js --network arbitrum-sepolia
# then on NEAR, per-market (funder) or contract-level:
#   setArbitrator({ account: "kleros-proxy.wide-mkt-11561.testnet" })
```

## Relayer (design — small cron service)

```
watch Ruling(disputeID, ruling) events
  → cases[disputeID].marketId / claimId
  → near call resolveDispute({marketId, claimId, ruling: nearRuling(disputeID)})
    from kleros-proxy.<contract>.testnet
```

The proxy account is just a signature relay — it cannot move funds on
its own; `resolveDispute` only executes arbitrator rulings, and the
market's arbitrator is whoever the funder named (or contract default).

## Ruling enum (must match the NEAR contract)

| uint | NEAR ruling    | effect                          |
|------|----------------|---------------------------------|
| 1    | pay_claim      | escrow settles to disputed claim |
| 2    | reject_claim   | claim rejected, market stays open|
| 3    | refund         | escrow voids back to payer       |
| 0/*  | dismiss        | resume normal adjudication       |

## Honest limits

- The relayer is a liveness dependency — anyone can run one; the ruling
  data itself is on-chain (EVM event + NEAR tx), so censorship is
  detectable, not exploitable.
- Juror time: Kleros disputes take days — the appeal lane is for
  contested verdicts, not the fast path.
- Deploy addresses are placeholders until a reviewed deployment exists.
