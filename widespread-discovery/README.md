# widespread-discovery

Permissionless cross-surface work discovery. Watchers observe work
declarations/claims/receipts on arbitrary platforms and publish sightings as
self-certifying Nostr events (kind 30078) to public relays. Relays are the
transport **and** the index — no Widespread-controlled component is required.

Spec: [`../docs/discovery-protocol.md`](../docs/discovery-protocol.md)

## Tiers (all optional, all equal)

| Tier | What | Install |
|---|---|---|
| 0 | `watcher-web/` static app — browser keypair, IndexedDB index, relay WS | none — visit a URL |
| 1 | `watcher-extension/` MV3 — watches credentialed surfaces you browse | browser extension |
| 2 | `wsd mcp` — stdio MCP server for any MCP host | `npx` |
| 3 | `wsd serve` — localhost HTTP API + watcher daemon | `npx` / npm |
| 4 | this package as a library | `npm i` |

The bridge (`widespread-bridge`) is an optional republish/cache adapter —
`sightings` work with it unconfigured.

## CLI

```sh
wsd keygen                                # identity in ~/.widespread-discovery
wsd publish --platform discourse:x --id 123 --text "widespread declare …"
wsd query --platform discourse:x          # relay query → local index
wsd watch https://forum.example/latest.json --kind json   # poll → publish
wsd serve --port 8787                     # localhost API (any language)
wsd mcp                                   # stdio MCP (Claude/Cursor/agents)
wsd stats                                 # local index stats
wsd sync-out / wsd sync-in                # encrypted cross-device state
```

Env: `WSD_RELAYS="wss://a,wss://b"` overrides the default relay set.

## Resilience

- Publish is per-relay isolated — one dead relay can't sink a batch;
  success = ≥1 acceptance, failures are reported per-relay.
- **Relay retention is verified, not assumed**: relays can return `OK:true`
  then silently drop events — observed live across most of the public
  relay set for kind-30078 (only `relay.snort.social`, `relay.primal.net`,
  and `nostr.bitcoiner.social` verified to store+serve them as of
  2026-11-14; `DEFAULT_RELAYS` contains only verified storers). `publish()`
  re-queries the event id after ACK and reports `stored`; sightings that
  are ACK'd-but-not-retained are queued to the outbox like hard failures —
  consistent with per-pubkey flood filtering, which decays and retries
  absorb.
- **Offline outbox** (`~/.widespread-discovery/outbox.json`): sightings that
  fail to publish are queued and flushed automatically on the next `watch`
  run or successful publish — relay flakiness never loses work.
- Publish loops pace at ~4 events/sec — public relays' flood filters trip
  on burst rate and respond with silent drops.
- `wsd serve` exposes the same index over localhost HTTP for non-Node
  clients; `wsd mcp` for MCP hosts.

## Library

```js
import { keygen, publishSighting, query, ingestEvents, loadIndex } from "widespread-discovery";
```

## Verified

- `node --test test/` — canonical-JSON/sign-message parity with the bridge,
  corroboration tiers, encrypted state + export/import roundtrips.
- Live: publish → verified-storing relays → `query` → indexed sighting
  with tier, confirmed retrievable post-ACK.
