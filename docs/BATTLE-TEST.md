# Battle-test checklist

Run before every release, demo, or hackathon submission. Automated lanes
first; the manual items at the bottom can't be automated.

## Automated (in order)

```bash
npm run sync:check          # generated copies match canonical sources
npm run test:all            # hermetic: 270 worker + 17 discovery + drift gate
npm run smoke               # live: relay, bridge endpoints, wsd cycle, serve
npm run test:browser        # real Chromium: PWA publish + extension SW publish
```

Expected: all green. `smoke` and `test:browser` hit live infra — a
transient public-relay flake can fail a row; rerun once before digging in.

## Manual (can't automate)

- [x] `watcher-web/` deployed to Pages **after the last `npm run sync`** —
      verified live at `master.widespread-watch.pages.dev` (generated
      bundle + relay list confirmed in served bytes)
- [x] `watcher-extension/` browse-test → **automated**: `node scripts/browse-test.mjs`
      (unpacked extension, declaration page, sighting retained on relay)
- [x] `wsd cdp-watch` against real Chrome (`--remote-debugging-port=9222`)
      — 1 sighting extracted from a JSON surface via CDP and published
- [x] earn loop on testnet — `node scripts/earn-loop-test.mjs`:
      challenge→register→claim(attested)→ship_prepare→sign→submit.
      Ship lands via `scripts/ship-claim.mjs` → `/dg/patch` (merged
      commit → bridge cron adjudicates → verdict in `/api/state`).
      See KNOWN DEFECTS note in that script — the `/dg/ship` relay path
      the MCP tool targets is a stale forge route.
- [x] `wss://widespread-relay…` NIP-11 — covered by `npm run smoke`
- [x] `wsd events export` → `import` round-trip on a second HOME — verified

### Defects found by battle testing (2026-11-13)

1. `wide_ship_submit` relays to `/dg/ship` — route does not exist on the
   forge (HTML 404). Working lane: `/dg/patch`.
2. dg1 signature convention mismatch — forge verifies
   `ed25519(utf8(sha256hex(canonical)))`; bridge `shipSubmit` verifies
   `ed25519(sha256bytes(canonical))`. Bridge-relayed sigs fail forge auth.
3. Forge repos start un-initialized (no base ref) — `/dg/patch` 404s until
   `/dg/import` bootstraps refs from a remote URL.
4. `POST /api/claims` with github forgeRef hits public GitHub rate limits —
   `ipfs://cid` + `evidence.artifact_inline` is the dependency-free path.
5. `/dg/import` of a large repo exceeds Worker CPU limits — import small
   repos for demos.

## What "passed" means

- Relay probes verify **retention**, not just ACK — `stored ≥ 1` after a
  follow-up query. `OK:true` alone is never success.
- Browser lanes run in real Chromium: PWA must reach `verdict:retained`,
  extension must return ≥1 relay acceptance from its service worker.
- Any `// GENERATED` file edited by hand fails `sync:check` — fix by
  editing the canonical source and running `npm run sync`.
