#!/usr/bin/env node
// wsd — Widespread Discovery CLI/daemon. Spec: docs/discovery-protocol.md
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  keygen, importIdentity, loadIdentity, publishSighting, query, ingestEvents,
  loadIndex, publishState, fetchState, relays, closePool,
} from "./node.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { values: a, positionals: pos } = parseArgs({
  args: rest,
  options: {
    platform: { type: "string" }, id: { type: "string" }, text: { type: "string" },
    url: { type: "string" }, author: { type: "string" }, ts: { type: "string" },
    nsec: { type: "string" }, file: { type: "string" },
    limit: { type: "string", default: "200" }, port: { type: "string", default: "8787" },
    kind: { type: "string", default: "json" }, akind: { type: "string" }, interval: { type: "string", default: "60" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const usage = `wsd — widespread-discovery CLI

  wsd keygen                      generate watcher identity (~/.widespread-discovery)
  wsd import --nsec nsec1…         import existing nostr identity
  wsd publish --platform P --id ID --text "…" [--url U --author A]
  wsd query [--platform P --id ID] [--limit N]
  wsd surface add URL          allowlist a surface (required before watch)
  wsd gen-openapi --file spec.yaml   OpenAPI → draft adapter manifest
  wsd surface                  list allowlisted surfaces
  wsd watch URL… [--kind json|rss]   poll allowlisted surfaces → publish
  wsd serve [--port 8787]         localhost HTTP API + background watcher
  wsd mcp                         stdio MCP server (agent integration)
  wsd stats                       local index stats
  wsd sync-out / wsd sync-in      publish/fetch encrypted watcher state
  env: WSD_RELAYS="wss://a,wss://b"`;

const needId = () => { const id = loadIdentity(); if (!id) { console.error("no identity — run `wsd keygen`"); process.exit(1); } return id; };

switch (cmd) {
  case "keygen": {
    const id = keygen();
    console.log(`identity created\n  pubkey: ${id.pubkey}\n  npub:   ${await import("nostr-tools").then(m => m.nip19.npubEncode(id.pubkey))}\n  stored: ~/.widespread-discovery/identity.json`);
    break;
  }
  case "import": {
    if (!a.nsec) { console.error("--nsec required"); process.exit(1); }
    const id = importIdentity(a.nsec);
    console.log(`imported pubkey ${id.pubkey}`);
    break;
  }
  case "publish": {
    needId();
    if (!a.platform || !a.id || !a.text) { console.error("--platform --id --text required"); process.exit(1); }
    const sight = { platform: a.platform, native_id: a.id, url: a.url, author: a.author, text: a.text, ts: a.ts ? Number(a.ts) : undefined };
    try {
      const r = await publishSighting(sight);
      console.log(`published ${r.event.id} → ${JSON.stringify(r.oks)}`);
    } catch (e) {
      const { queueSighting } = await import("./node.mjs");
      await queueSighting(sight);
      console.log(`queued for retry (relays unreachable): ${e.message}`);
    }
    closePool(); setTimeout(()=>process.exit(0),300); break;
  }
  case "query": {
    needId();
    const filter = { kinds: [30078], "#t": ["widespread-sighting"] };
    if (a.platform && a.id) filter["#d"] = [`${a.platform}:${a.id}`];
    const evs = await query(filter, Number(a.limit) * 4);
    const n = await ingestEvents(evs);
    const idx = loadIndex();
    const rows = Object.values(idx.sightings).filter((s) =>
      (!a.platform || s.platform === a.platform) && (!a.id || s.native_id === a.id)).slice(-Number(a.limit));
    for (const s of rows) console.log(`[${s.tier ?? "?"}] ${s.platform}:${s.native_id} — ${s.text.slice(0, 120)}`);
    console.log(`— ${evs.length} events, ${n} new, index=${Object.keys(idx.sightings).length}`);
    closePool(); setTimeout(()=>process.exit(0),300); break;
  }
  case "surface": {
    const { loadSurfaces, addSurface } = await import("./node.mjs");
    if (pos[0] === "add") {
      const url = pos[1]; if (!url) { console.error("usage: wsd surface add URL [--platform P] [--kind json|rss|hn]"); process.exit(1); }
      const list = addSurface({ platform: a.platform ?? new URL(url).hostname, url, kind: a.kind });
      console.log(`allowlisted (${list.length} surfaces)`);
    } else console.log(JSON.stringify(loadSurfaces(), null, 2));
    break;
  }
  case "watch": {
    needId();
    const urls = pos.length ? pos : [a.file].filter(Boolean);
    if (!urls.length) { console.error("usage: wsd watch URL… (URL must be allowlisted: wsd surface add URL)"); process.exit(1); }
    const { watchOnce } = await import("./watch.mjs");
    const { assertAllowlisted } = await import("./node.mjs");
    const surfs = urls.map((u) => ({ platform: a.platform ?? new URL(u).hostname, url: u, kind: a.kind }));
    assertAllowlisted(surfs); // trifecta: no agent-chosen fetch URLs
    const once = await watchOnce(surfs);
    console.log(`watch complete: ${once.published} published, ${once.seen} seen`);
    if (a.interval && a.interval !== "0") {
      setInterval(() => watchOnce(surfs).catch(console.error), Number(a.interval) * 1000);
      console.log(`polling every ${a.interval}s — ctrl-c to stop`);
    }
    break;
  }
  case "serve": {
    needId();
    const { serve } = await import("./serve.mjs");
    serve({ port: Number(a.port) });
    break;
  }
  case "mcp": {
    needId();
    const { mcpStdio } = await import("./mcp.mjs");
    mcpStdio();
    break;
  }
  case "gen-openapi": {
    const { readFileSync } = await import("node:fs");
    if (!a.file) { console.error("usage: wsd gen-openapi --file spec.yaml [--surface host] [--kind api]"); process.exit(1); }
    const { specToManifest, parseSpec } = await import("./gen-openapi.mjs");
    const spec = parseSpec(readFileSync(a.file, "utf8"));
    const m = specToManifest(spec, { surface: a.platform, kind: a.akind ?? "api" });
    console.log(JSON.stringify(m, null, 2));
    console.error(`— ${m.ops.length} ops emitted as draft; sign+publish via plugin or /api/adapters`);
    break;
  }
  case "stats": {
    const idx = loadIndex();
    const rows = Object.values(idx.sightings);
    const byPlatform = {}, byTier = {};
    for (const s of rows) { byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1; byTier[s.tier ?? "?"] = (byTier[s.tier ?? "?"] ?? 0) + 1; }
    console.log(JSON.stringify({ sightings: rows.length, by_platform: byPlatform, by_tier: byTier, watermark: idx.watermark, relays: relays() }, null, 2));
    break;
  }
  case "sync-out": needId(); console.log(JSON.stringify((await publishState(await collectState())).event.id)); closePool(); setTimeout(()=>process.exit(0),300); break;
  case "sync-in": needId(); console.log(JSON.stringify(await fetchState(), null, 2)); closePool(); setTimeout(()=>process.exit(0),300); break;
  default:
    console.log(a.help || !cmd ? usage : `unknown command: ${cmd}\n\n${usage}`);
}

async function collectState() {
  const idx = loadIndex();
  return { v: 1, watermark: idx.watermark || Math.floor(Date.now() / 1000) - 86400,
    watch_config: { relays: relays() },
    seen_tail: Object.keys(idx.sightings).slice(-500) };
}
