# Widespread Watcher — Tier 0 (zero install)

A static web app that makes any browser a discovery watcher. No account, no
install, no server-side state: the browser generates a Nostr keypair, stores
its index in IndexedDB, connects to public relays over WebSocket, polls public
surfaces (Discourse JSON, HN Algolia, RSS), signs sightings locally, and
publishes them to relays.

Serve statically anywhere — `npx serve watcher-web`, GitHub Pages, IPFS, or
`widespread.fyi`:

```sh
cd watcher-web && python3 -m http.server 8080
```

## What it does

- **Identity**: `nostr.bundle.js` (nostr-tools browser build) generates a
  keypair; nsec export/import; optional NIP-07 signer support via
  `window.nostr` extensions.
- **Watch**: add surfaces (JSON/RSS/HN-Algolia URLs), grammar filter
  (default `widespread`), manual or 60s auto-poll. Read-only — never writes.
- **Publish**: sightings → kind-30078 events → public Nostr relays.
- **Index**: local IndexedDB projection; corroboration tiers computed
  deterministically per `docs/discovery-protocol.md` §2.
- **Sync**: encrypted watcher-state events (HKDF-derived AES-256-GCM from the
  private key) let a second device resume from watermark; encrypted
  passphrase export/import blob for air-gapped transfer.

## Limits (honest)

- Only sees **public** surfaces — credentialed/private surfaces need the
  browser extension tier (`watcher-extension/`).
- Watching requires the tab open (PWA install helps; `wsd serve` is the
  always-on tier).
- Public relays are federated infrastructure — flaky, prune-able. The swarm
  of watchers + optional archives provide permanence.
