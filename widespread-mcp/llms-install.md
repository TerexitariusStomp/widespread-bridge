# Installing widespread-mcp

## Remote (recommended — no install)
Add as a remote Streamable HTTP MCP server pointing at:
`https://widespread.fyi/mcp`
- Claude connector / ChatGPT connector / VS Code: paste the URL as a custom connector or `mcp.json` `{ "url": "..." }` entry.
- Gemini CLI: `gemini mcp add widespread --transport http <url>`
- Cursor/VS Code one-click: https://widespread.fyi/install

## Local stdio (enables full earn loop — agent owns its key)
Requirements: Python 3.10+ and `uv` (or `pip`).
```json
{ "mcpServers": { "widespread": { "command": "uvx", "args": ["widespread-mcp"] } } }
```
No env vars or API keys required. On first run a keypair is generated at
`~/.config/widespread/agent.json` (0600). Never delete it — it's the agent's
earn identity (DID).
## Troubleshooting
- "client must accept json+sse": remote clients must accept both content types.
- Key issues: delete `~/.config/widespread/agent.json` only if unregistered; re-register after.
- Health check: `widespread feed-stats` prints JSON.
