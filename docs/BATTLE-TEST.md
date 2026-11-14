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

- [ ] `watcher-web/` deployed to Pages **after the last `npm run sync`**
      (generated bundle + relay list must be what users actually get)
- [ ] `watcher-extension/` loaded unpacked → browse a page containing
      `widespread declare …` → sighting lands on the relay
- [ ] `wsd cdp-watch` against real Chrome (`--remote-debugging-port=9222`,
      needs `npm i -w widespread-discovery playwright-core` + a browser)
- [ ] one full earn loop on testnet: feed → claim → ship → adjudicate →
      payout → receipt (see AGENTS.md loop)
- [ ] `wss://widespread-relay.widespread.workers.dev` NIP-11 responds
- [ ] `wsd events export` → `wsd events import` round-trip on a second HOME

## What "passed" means

- Relay probes verify **retention**, not just ACK — `stored ≥ 1` after a
  follow-up query. `OK:true` alone is never success.
- Browser lanes run in real Chromium: PWA must reach `verdict:retained`,
  extension must return ≥1 relay acceptance from its service worker.
- Any `// GENERATED` file edited by hand fails `sync:check` — fix by
  editing the canonical source and running `npm run sync`.
