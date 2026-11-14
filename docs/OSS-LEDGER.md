# OSS ledger + custom-code accounting

Goal: discovery/broker stack built on commercially usable OSS + platform
primitives; custom code < 5% of an equivalent standalone system.
Copyleft is acceptable; every imported dep is license-checked.

## Dependencies (widespread-discovery)

| Package | Version | License | Used for |
|---|---|---|---|
| nostr-tools | ^2.26.0 | BSD-2-Clause | Nostr event build/sign/pool (node tier) |
| playwright-core | 1.64.1 (pinned, >7d old) | Apache-2.0 | CDP attach to real browser (P3) |
| yaml | ^2.8.0 | ISC | OpenAPI YAML parsing (gen-openapi) |

## Vendored / platform primitives

| Component | License | Used for |
|---|---|---|
| `nostr-tools/lib/nostr.bundle.js` (vendored, watcher-web + extension) | BSD-2-Clause | entire browser crypto+relay stack, zero bundler |
| NIP-07 `window.nostr` | platform | sign with user's existing Nostr signer |
| WebCrypto / IndexedDB / ServiceWorker / fetch / WebSocket | platform | keys, index, PWA, transport — zero code |
| chrome.* extension APIs, Tampermonkey `GM_xmlhttpRequest` | platform | credentialed in-context requests |
| node:http, util.parseArgs, node:test | platform | daemon/CLI |
| MCP SDK (@modelcontextprotocol/sdk, bridge repo) | MIT | `wsd mcp` |

## Explicitly excluded

- **Nango `integration-templates`** — custom "Other" license, not audited;
  only its API-coverage *facts* may be used as a demand signal.
- **Composio / Arcade** — closed source; no import path. Used only as
  competitive reference.
- **Cookie-store decryption tools** — App-Bound Encryption makes them
  infostealer-shaped; rejected on threat-model grounds, not license.

## Custom LOC (excl. vendored bundles, tests)

| Component | LOC |
|---|---|
| widespread-discovery/src (9 files) | ~960 |
| watcher-web (app/store/sw/html) | ~438 |
| watcher-extension (bg/broker/content/userscript) | ~383 |
| widespread_surfaces grant+path-param additions | ~120 |
| **Total custom** | **~1,900** |

Equivalent standalone system estimate: a multi-surface watcher network +
credential broker + adapter runtime + relay client + web app + daemon +
MCP server + OpenAPI transpiler is realistically 25k–60k LOC (compare:
Nango core ~30k, a Composio-class connector SDK far larger).

**Ratio: ~1,900 / ~38k midpoint ≈ 5%.** Honest range 3–8% depending on
which equivalent you price; the spec+tests+docs are the irreducible
custom residue — everything else is OSS or platform primitives.
