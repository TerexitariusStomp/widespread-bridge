# Publishing to the official MCP Registry

**Status: PUBLISHED** — `fyi.widespread/mcp@1.0.0` is live and `active` in the
official registry (verified 2026-11-14). DNS auth used the Ed25519 keypair in
`~/.widespread-mcp/` (never commit it); the proof TXT record stays at the apex
of `widespread.fyi` — it is required for every future `login dns`, so do NOT
remove it unless rotating keys (then replace it in the same change).

`server.json` at the repo root is the manifest for
`fyi.widespread/mcp` — a remote-only server (Streamable HTTP at
`https://widespread.fyi/mcp`). No package is published; the registry hosts
metadata only.

## Prerequisites

```bash
brew install mcp-publisher   # or the curl one-liner from the registry docs
```

## Path A — domain namespace (preferred): `fyi.widespread/mcp`

The name is the reverse-DNS form of `widespread.fyi`, so publishing proves you
control the domain.

1. `mcp-publisher login dns` — generates an Ed25519 keypair and prints a TXT
   record payload.
2. Add that TXT record at the **apex** of `widespread.fyi` (e.g.
   `widespread.fyi.  TXT  "v=MCPv1; k=ed25519; p=..."`). Apex placement is
   required — a selector like `_mcp.widespread.fyi` will fail.
3. Re-run `mcp-publisher login dns` to verify, then:

   ```bash
   mcp-publisher validate server.json
   mcp-publisher publish server.json
   ```

4. Keep the TXT record — future `login dns` calls verify against it. Only
   remove/replace it when rotating to a new keypair.

## Path B — GitHub namespace (works today, no DNS)

`mcp-publisher login github` (device flow) publishes under
`io.github.TerexitariusStomp/widespread`. Copy `server.json`, change `name` to
`io.github.TerexitariusStomp/widespread`, validate and publish. Downside: the
listing shows a GitHub namespace instead of the product domain — Path A is
worth doing before launch announcements.

## After publishing

- Bump `version` in `server.json` for each publish; the registry versions
  listings.
- Verify the listing at `https://registry.modelcontextprotocol.io` and link it
  from `/docs` and `/llms.txt` once live.
