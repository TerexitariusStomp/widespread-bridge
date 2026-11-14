# Widespread — testing

The universal verified-work protocol monorepo (Worker + discovery +
watchers + relay). Default test commands are **hermetic** — they never
touch mainnet, real money, or unmocked third parties. Live coverage is
opt-in.

| Command | Scope | Live? |
|---|---|---|
| `npm test` | 272 vitest unit tests — claims, fiat, mirrorclaims, payouts, nearops (tx serialization + base58), ingest, forge adapters (dg1 writeback, binding resolution), XSS escaping, feed, hats, web pages, coordinator | no |
| `npm run test:all` | worker suite + `widespread-discovery` node:test (17) + `sync:check` drift gate on generated copies | no |
| `npm run typecheck` | `tsc --noEmit` | no |
| `npm run sync` / `sync:check` | regenerate / verify watcher-web + extension copies from canonical sources (`widespread-discovery/src/`, nostr-tools) | no |
| `E2E_LIVE=1 npm test` | additionally runs `test/e2e.live.test.ts` against the deployed worker | yes (read-only probes) |
| `npm run smoke` | `scripts/smoke.mjs` — live battle test: relay NIP-11 + kind-30078 round-trip + 10-event pipelined burst, bridge endpoints, wsd keygen→publish→query cycle in temp HOME, gen-openapi, `wsd serve`, vendor bundles, relay worker.js patch check | yes |
| `npm run test:browser` | `scripts/test-browser.mjs` — real Chromium via playwright-core: PWA loads generated bundle → keygen → snapshot publish → `verdict:retained`; unpacked extension's service worker publishes a sighting to relays | yes (needs `node node_modules/playwright-core/cli.js install chromium`; extension lane needs a display) |
| `npm run test:earn` | `scripts/earn-loop-test.mjs` — challenge → register → funded market → `/api/claims` attestation → ship prepare/sign/submit → status, against the live bridge + NEAR testnet | yes (testnet) |
| manual checklist | `docs/BATTLE-TEST.md` — Pages redeploy, extension browse-test, cdp-watch, export/import round-trip | yes |

Notes: KV/NEAR-RPC are stubbed in unit tests via `test/mock.ts`.

## Forge adapters

`src/forges/` isolates forge-specific behavior behind the `ForgeAdapter`
interface. `test/writeback.test.ts` verifies the delta-git adapter's dg1
envelope byte-for-byte (the exact `ed25519(utf8(sha256hex(dg1\n…)))`
convention the forge checks) plus `FORGES`/`FORGE_BASE` binding resolution.

Other repos in the ecosystem (delta-git forge, agent clients, runner,
bot) own their own test matrices — see each repo's TESTING/AGENTS docs.

## CI

`.github/workflows/test.yml` runs the hermetic suites only
(`E2E_LIVE` unset). Live lanes stay manual/opt-in.
