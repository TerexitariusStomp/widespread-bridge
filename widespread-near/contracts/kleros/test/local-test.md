# Local functional test (2026-11-14)

Compiled both contracts with solc 0.8.38, deployed on a local hardhat
node, exercised the full path via viem:

- `WidespreadArbitrable` deploy + `openDispute("24","1")` at 0.01 ETH
  arbitration cost — bound the NEAR market/claim pair
- `submitEvidence(1, "ipfs://…")` emitted the Kleros-standard Evidence event
- `MockArbitrator.giveRuling` → `rule(1, 1)` → `nearRuling(1) = "pay_claim"`
- second case: `rule(2, 3)` → `nearRuling(2) = "refund"` — enum roundtrip

The mock stands in for KlerosLiquid's juror path; in production only the
real arbitrator can call `rule()` (onlyArbitrator modifier enforced).
Remaining for a live deploy: an Arb Sepolia deployment + `setArbitrator`
to the `kleros-proxy.*` NEAR account + a running relay.mjs instance.
