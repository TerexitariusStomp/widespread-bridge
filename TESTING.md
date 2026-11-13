# Widespread — testing matrix

Every repo's test command, what it covers, and what stays gated. Default
test commands are **hermetic** — they never touch mainnet, real money, or
unmocked third parties. Live coverage is opt-in via `E2E_LIVE=1`.

## widespread-bridge (Cloudflare Worker)

| Command | Scope | Live? |
|---|---|---|
| `npm test` | 86 vitest unit tests — claims, fiat, mirrorclaims, payouts, nearops (tx serialization + base58), ingest, writeback, XSS escaping, feed, hats, web pages | no |
| `npm run typecheck` | `tsc --noEmit` | no |
| `E2E_LIVE=1 npm test` | additionally runs `test/e2e.live.test.ts` against the deployed worker | yes (read-only probes) |
| `node scripts/e2e-lifecycle.mjs` | flagship demo: fund → claim → verdict → payout → receipt against live sandbox rails | yes |

Notes: KV/NEAR-RPC are stubbed in unit tests via `test/mock.ts`.
Live tests reuse KV dedupe keys — safe to re-run.

## widespread-near (NEAR contracts)

| Command | Scope | Live? |
|---|---|---|
| `node --test test/market.test.mjs test/hats.test.mjs` | 23 tests driving the real contract classes through an esbuild harness with a stubbed `near-sdk-js` runtime — market create/claim/release/refund/pagination, hats org/tree/assign/foreign-id/sign-request/stance/payout | no |
| `E2E_LIVE=1 node --test test/live.test.mjs` | full market lifecycle on NEAR testnet via near-api-js v7 (`callFunction` + raw query views): createMarket → shipClaim ×2 → release → on-chain paid state | yes (testnet) |

Requires `~/.widespread-near.json` deploy creds for the live test. The
harness caught and fixed a real `refund` crash on `deadline: null`
markets (the bridge mirror-escrow shape).

## near-hermes-browser

| Command | Scope | Live? |
|---|---|---|
| `npm test` | 14 node:test (vault ops, NEAR key custody — fake-indexeddb) + 10 python unittest (widespread plugin: RFC 8032 ed25519, dg1 envelope) | no |
| `npm run build && npm run smoke` | Playwright smoke: Pyodide backend boot, REST + ws JSON-RPC round-trips, vault boundary (secrets stored as `vault:` handles) | local only |

`npm install` is required for the JS tests (`fake-indexeddb`,
`near-api-js`). Smoke needs `npm run build` first (vendors hermes-agent,
packs Pyodide env, assembles `dist/`) plus `npx playwright install`.

## delta-git (forge)

| Command | Scope | Live? |
|---|---|---|
| `npm run test` | 107 node unit tests | no |
| `npm run test:workers` | 784 worker integration tests (vitest-pool-workers) | no |
| `npm run test:auth` | auth worker subset | no |
| `npm run test:e2e` | Playwright suite (needs built SPA) | no |

Known environment-dependent failures (not regressions): 7 SPA-asset
tests 404 when `frontend/canary` was never built (`npm run build:spa`
needs the full pnpm workspace install), and the CT-log certificate probe
needs live internet.

## widespread-runner

| Command | Scope | Live? |
|---|---|---|
| `npm test` | 3 tests — dg-ship-1 claim flow against a stub forge (signature verified against registered pubkey), env attestation shape, failure propagation | no |

The Docker sandbox path (`runInSandbox`) is integration-only — needs the
`widespread-sandbox` image and docker daemon.

## widespread-solana

| Command | Scope | Live? |
|---|---|---|
| `npm test` | 12 tests — contentHash, memoIx, keypair IO, Intents quote/status/settlement-gate with stubbed fetch | no |
| `npm run demo` / `payout` / `anchor` | devnet PYUSD escrow + memo-anchored payout | yes (devnet) |

## widespread-bot (GitHub App)

| Command | Scope | Live? |
|---|---|---|
| `npm test` | 16 tests — verdict parser + all webhook handlers (bounty seeding, merge=accept, bot-verdict emission, negative paths) with fake Probot context | no |

## slopdotcash (legacy system of record)

| Command | Scope | Live? |
|---|---|---|
| `bun test --timeout 30000 ./scripts ./workers ./backend ./contracts` | 1706 tests | mostly no |
| `bun run test:integration` / `test:e2e`-family scripts | integration + e2e lanes | varies |

Requires **bun ≥ 1.4** (1.3 fails `beforeAll` signature checks). One
known environment-sensitive failure on Node 26:
`scripts/e2e-runner.test.ts` "registry fixture writes survive
idle-socket closure" — undici socket-timing semantics; unrelated to
Widespread changes.

## foreguild (Seer/futarchy)

No application test suite — Solidity/TS experiment repo; covered
indirectly through the bridge's futarchy quote path. Excluded from the
test matrix.

## CI

`.github/workflows/test.yml` runs the hermetic suites only
(`E2E_LIVE` unset). Live lanes stay manual/opt-in.
