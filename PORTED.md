# Ported code — provenance map

This repo absorbs protocol-relevant internals from
[LocalChimera](https://github.com/LocalChimera/localchimera) (AGPL-3.0-or-later,
© LocalChimera contributors). LocalChimera is our upstream: absorbed code
retains its AGPL notices and attribution. Nothing in the bridge depends on
the LocalChimera deployment at runtime — the coordinator IS this worker's
Durable Object.

| File | Ported from | License |
|---|---|---|
| `src/coordinator/didkey.ts` | `localchimera/workers/coordinator/src/didkey.ts` | AGPL-3.0 |
| `src/coordinator/registry.ts` | `localchimera/workers/coordinator/src/registry.ts` | AGPL-3.0 |
| `src/coordinator/coordinator-do.ts` | `localchimera/workers/coordinator/src/coordinator-do.ts` (core dispatch/registry/ledger/audit/canary — EVM chain polling, x402, patronage, committee, ENS, and proxy surfaces dropped) | AGPL-3.0 |

New Widespread-owned code (MIT, this repo): `src/artifacts.ts`,
`src/upstream.ts`, `src/domains/compute.ts`, and the Widespread task-type
range (400–499), feed-ingest alarm, challenge issuer, signed `/api/jobs/:id`
records, and replica tally inside `src/coordinator/`.

## Task-type ranges (coordinator)

| Range | Owner |
|---|---|
| 0–3 | canonical (inference/storage/compute/bandwidth) — chimera compat |
| 100–103 | wp-cloud (unused here) |
| 200–206 | project jobs (CANARY at 206 — honesty probes) |
| 300–301 | swarm (durable-gated) |
| **400–403** | **widespread task markets** — claim/verify/inference/artifact (durable-gated) |
| **410–412** | **widespread resource markets** — compute/bandwidth/storage (durable-gated, challenge-verified) |

## Related ports

`widespread-runner` absorbs the node side (providers, metering, receipt
gossip, QVAC inference, BTFS client) — see its `PORTED.md`.

## Deliberately not carried

Tauri shells, website/wiki products, browser extension, Cashu, namesilo-proxy,
selfhost tooling, `upstream/` daemon source trees (daemons are spawned at
pinned versions, never vendored), `widespread-adapter.js` (unrelated wallet
shim), wp-cloud site pooling, Robinhood-chain escrow polling (replaced by the
feed-ingest alarm over this bridge's own feed + NEAR market view).
