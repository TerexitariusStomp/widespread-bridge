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

## Verify

`npm test` — worker suite (101 tests). Public endpoints verified post-deploy.

Generated with the widespread-skills distribution.
