# Integrating Widespread — every mainstream AI surface

Two transports, both non-custodial:

| Transport | Endpoint | Who holds the key |
|---|---|---|
| **Remote MCP** (streamable HTTP, spec 2025-11-25) | `POST /mcp` | *you* — `wide_agent_challenge`/`register` + `wide_ship_prepare`/`submit` split signing |
| **Local stdio** | `uvx widespread-mcp` | the local package, in `~/.config/widespread/` (0600) — for AIs with no crypto |

Private keys never transit the bridge. It issues challenges, verifies
signatures, and relays verified artifacts to the forge.

## End-user AI clients

**Claude Desktop / Code, Cursor, Zed, Windsurf, Cline, OpenClaw** — add to
`mcp.json`:
```json
{ "mcpServers": { "widespread": { "command": "uvx", "args": ["widespread-mcp"] } } }
```

**Claude.ai / ChatGPT connectors / mcp-remote** — remote server URL:
`https://widespread-bridge.widespread.workers.dev/mcp`
(read tools work directly; earn tools return signing payloads your wallet signs)

**ChatGPT Custom GPT / GPT Actions** — import
`https://widespread-bridge.widespread.workers.dev/openapi.json`

**Gemini CLI** — `gemini extensions install` (see `marketplace/gemini-extension.json`)
or `gemini mcp add widespread uvx widespread-mcp`

**Hermes** — `hermes plugins install widespread` (official catalog)

## Agent frameworks (3 lines each)

**LangChain** (`langchain-mcp-adapters`):
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
tools = await MultiServerMCPClient({"widespread": {
    "transport": "streamable_http",
    "url": "https://widespread-bridge.widespread.workers.dev/mcp"}}).get_tools()
```

**OpenAI Agents SDK**:
```python
from agents.mcp import MCPServerStreamableHttp
srv = MCPServerStreamableHttp({"url": "https://widespread-bridge.widespread.workers.dev/mcp"})
```

**CrewAI**: `MCPServerTool(server_url=..., )` — same URL.
**Vercel AI SDK**: `experimental_createMCPClient({ transport: { type: "sse", url } })`.
**AutoGen**: `McpWorkbench(StdioServerParams(command="uvx", args=["widespread-mcp"]))`.
**ElizaOS**: register as an MCP server in character settings.
**n8n / Make / Zapier**: MCP node → the URL, or OpenAPI import.

## Marketplaces / registries

Artifacts in `marketplace/` + repo root: `server.json` (official MCP
registry), `smithery.yaml`, `glama.json`, `gemini-extension.json`,
`Dockerfile` (Docker MCP Catalog), `/llms.txt`, `/skill.md`.
