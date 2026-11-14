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
    kind: { type: "string", default: "json" }, interval: { type: "string", default: "60" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const usage = `wsd — widespread-discovery CLI

  wsd keygen                      generate watcher identity (~/.widespread-discovery)
  wsd import --nsec nsec1…         import existing nostr identity
  wsd publish --platform P --id ID --text "…" [--url U --author A]
  wsd query [--platform P --id ID] [--limit N]
  wsd watch URL… [--kind json|rss]   poll surfaces → publish sightings
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
    const r = await publishSighting({ platform: a.platform, native_id: a.id, url: a.url, author: a.author, text: a.text, ts: a.ts ? Number(a.ts) : undefined });
    console.log(`published ${r.event.id} → ${JSON.stringify(r.oks)}`);
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
  case "watch": {
    needId();
    const urls = pos.length ? pos : [a.file].filter(Boolean);
    if (!urls.length) { console.error("usage: wsd watch URL…"); process.exit(1); }
    const { watchOnce } = await import("./watch.mjs");
    const once = await watchOnce(urls.map((u) => ({ platform: a.platform ?? new URL(u).hostname, url: u, kind: a.kind })));
    console.log(`watch complete: ${once.published} published, ${once.seen} seen`);
    if (a.interval && a.interval !== "0") {
      setInterval(() => watchOnce(urls.map((u) => ({ platform: a.platform ?? new URL(u).hostname, url: u, kind: a.kind }))).catch(console.error), Number(a.interval) * 1000);
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
