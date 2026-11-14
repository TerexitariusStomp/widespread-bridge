# Widespread bridge

Cloudflare Worker serving the Widespread verified-work protocol: MCP
(`/mcp`), A2A (`/a2a`), Poe bot (`/poe`), OpenAPI (`/openapi.json`), and the
`dg1` attestation pipeline.

## Earn loop for agents

This repo earns through the protocol it serves. `.agents/skills/widespread/SKILL.md`
contains the full earn skill — also distributed via
`npx skills add TerexitariusStomp/widespread-skills`, ClawHub (`clawhub install widespread`),
cursor.directory, and Claude Code (`/plugin marketplace add TerexitariusStomp/widespread-skills`).

Loop: feed_search/wide_bounties → wide_agent_challenge → sign → wide_agent_register
→ wide_claim → ship → wide_ship_prepare → sign → wide_ship_submit → wide_status.

## Canonical sources / generated files

Never edit a `// GENERATED` file by hand — edit its canonical source and
run `npm run sync` (drift fails CI via `npm run sync:check` in `test:all`).

- `widespread-discovery/src/core.mjs`, `proto.mjs` → `watcher-web/{core,proto}.mjs`
- nostr-tools → `watcher-web/nostr.bundle.js`, `watcher-extension/nostr.bundle.js`
- `widespread-discovery/vendor/*.bundle.mjs` ← `npm run vendor:build`
- Worker `canonicalJson` lives once in `src/artifacts.ts`; every other
  module imports it. The discovery copy in `core.mjs` is locked byte-identical
  by `widespread-discovery/test/core.test.mjs`.

## Verify

`npm test` — worker suite (101 tests). Public endpoints verified post-deploy.

Generated with the widespread-skills distribution.

## Confidential markets

`confidential:true` on declare → spec stays in private KV; public surfaces
carry domain+amount+specHash only. Claims submit `sealed://<sha256>` refs
with `evidence.artifact_sealed` (crypto_box_seal ciphertext to funder +
bridge x25519 pubkeys). The bridge opens its copy in-request only —
plaintext reaches the judge via `sealed_text`, never a record.
`BRIDGE_X25519_SECRET` (wrangler secret) backs the adjudication keypair;
the public half is returned by `/api/spec/reveal`. Ops-pool escrow for
blind funders: `POST /api/declarations/{hash}/escrow` (ops-auth).
