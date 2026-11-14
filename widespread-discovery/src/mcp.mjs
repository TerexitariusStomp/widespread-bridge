// mcp.mjs — stdio MCP server exposing discovery tools to any MCP host.
// Hand-rolled JSON-RPC (initialize/tools/list/tools/call) — zero deps.
import { loadIdentity, loadIndex, publishSighting, query, ingestEvents, publishState, fetchState } from "./node.mjs";
import { parseArgs } from "node:util";

const TOOLS = [
  { name: "wsd_publish", description: "Publish a sighting (observed work item) to the discovery relays", inputSchema: { type: "object", properties: { platform: { type: "string" }, native_id: { type: "string" }, text: { type: "string" }, url: { type: "string" }, author: { type: "string" } }, required: ["platform", "native_id", "text"] } },
  { name: "wsd_query", description: "Query relays for sightings and update the local index", inputSchema: { type: "object", properties: { platform: { type: "string" }, native_id: { type: "string" }, limit: { type: "number" } } } },
  { name: "wsd_sightings", description: "Search the local sighting index", inputSchema: { type: "object", properties: { platform: { type: "string" }, native_id: { type: "string" }, text_contains: { type: "string" }, limit: { type: "number" } } } },
  { name: "wsd_stats", description: "Local index statistics", inputSchema: { type: "object", properties: {} } },
  { name: "wsd_state_publish", description: "Publish encrypted watcher state for cross-device sync", inputSchema: { type: "object", properties: { state: { type: "object" } }, required: ["state"] } },
  { name: "wsd_state_fetch", description: "Fetch latest encrypted watcher state", inputSchema: { type: "object", properties: {} } },
];

async function call(name, args = {}) {
  switch (name) {
    case "wsd_publish": {
      const r = await publishSighting({ platform: args.platform, native_id: args.native_id, text: args.text, url: args.url, author: args.author });
      return { event_id: r.event.id, oks: r.oks };
    }
    case "wsd_query": {
      const filter = { kinds: [30078], "#t": ["widespread-sighting"], limit: args.limit ?? 200 };
      if (args.platform) filter["#d"] = [`${args.platform}:${args.native_id ?? ""}`];
      const evs = await query(filter);
      const n = await ingestEvents(evs);
      return { events: evs.length, ingested: n };
    }
    case "wsd_sightings": {
      const idx = loadIndex();
      let rows = Object.values(idx.sightings);
      if (args.platform) rows = rows.filter((s) => s.platform === args.platform);
      if (args.native_id) rows = rows.filter((s) => s.native_id === args.native_id);
      if (args.text_contains) { const t = args.text_contains.toLowerCase(); rows = rows.filter((s) => s.text.toLowerCase().includes(t)); }
      return { sightings: rows.slice(-(args.limit ?? 100)) };
    }
    case "wsd_stats": {
      const idx = loadIndex();
      const rows = Object.values(idx.sightings);
      const byPlatform = {}, byTier = {};
      for (const s of rows) { byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1; byTier[s.tier ?? "?"] = (byTier[s.tier ?? "?"] ?? 0) + 1; }
      return { sightings: rows.length, by_platform: byPlatform, by_tier: byTier };
    }
    case "wsd_state_publish": return { event_id: (await publishState(args.state)).event.id };
    case "wsd_state_fetch": return { state: await fetchState() };
    default: throw new Error(`unknown tool ${name}`);
  }
}

export function mcpStdio() {
  const id = loadIdentity();
  if (!id) { console.error("wsd: no identity — run `wsd keygen`"); process.exit(1); }
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const reply = async (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const fail = (e) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } }) + "\n");
      try {
        if (msg.method === "initialize") await reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "widespread-discovery", version: "0.1.0" } });
        else if (msg.method === "notifications/initialized" || msg.method?.startsWith("notifications/")) { /* no reply */ }
        else if (msg.method === "tools/list") await reply({ tools: TOOLS });
        else if (msg.method === "tools/call") {
          const r = await call(msg.params?.name, msg.params?.arguments ?? {});
          await reply({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] });
        }
        else if (msg.id !== undefined) await reply({});
      } catch (e) { fail(e); }
    }
  });
}
