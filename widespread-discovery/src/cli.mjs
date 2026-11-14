#!/usr/bin/env node
// wsd — Widespread Discovery CLI/daemon. Spec: docs/discovery-protocol.md
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

// Public relays are flaky — a stray pool-level rejection must not kill the
// process; real errors still surface through their awaited call sites.
process.on("unhandledRejection", (e) => {
  console.error(`warning: unhandled rejection (relay/pool): ${String(e?.message ?? e).slice(0, 160)}`);
});
import {
  keygen, importIdentity, loadIdentity, publish, publishSighting, publishRawEvent, query, ingestEvents,
  loadIndex, publishState, fetchState, relays, closePool, readEventLog, ingestEnvelopes,
} from "./node.mjs";
import { metaEventTemplate, adapterEventTemplate, parseMetaPayload, ratifyMeta, collectAdapters, T_PROTOCOL_META, T_ADAPTER } from "./proto.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { values: a, positionals: pos } = parseArgs({
  args: rest,
  options: {
    platform: { type: "string" }, id: { type: "string" }, text: { type: "string" },
    url: { type: "string" }, author: { type: "string" }, ts: { type: "string" },
    nsec: { type: "string" }, file: { type: "string" },
    limit: { type: "string", default: "200" }, port: { type: "string", default: "8787" },
    kind: { type: "string", default: "json" }, akind: { type: "string" }, interval: { type: "string", default: "60" },
    surface: { type: "string" }, grammar: { type: "string" }, once: { type: "boolean" }, timeout: { type: "string" },
    help: { type: "boolean", short: "h" }, apply: { type: "boolean" },
  },
  allowPositionals: true,
});

const usage = `wsd — widespread-discovery CLI

  wsd keygen                      generate watcher identity (~/.widespread-discovery)
  wsd import --nsec nsec1…         import existing nostr identity
  wsd publish --platform P --id ID --text "…" [--url U --author A]
  wsd flush                       batch-publish queued sightings (pipelined WS)
  wsd query [--platform P --id ID] [--limit N]
  wsd surface add URL          allowlist a surface (required before watch)
  wsd cdp-watch --platform web --surface URL   watch via real browser (CDP)
  wsd gen-openapi --file spec.yaml   OpenAPI → draft adapter manifest
  wsd surface                  list allowlisted surfaces
  wsd watch URL… [--kind json|rss]   poll allowlisted surfaces → publish
  wsd serve [--port 8787]         localhost HTTP API + background watcher
  wsd mcp                         stdio MCP server (agent integration)
  wsd stats                       local index stats
  wsd snapshot                   publish capacity snapshot event (public C(t) index)
  wsd meta publish <payload.json>  sign a protocol-governance payload (steward key)
  wsd meta fetch                 show ratified protocol parameters + pending votes
  wsd adapter publish <manifest.json>  publish adapter manifest to relays (registry without a host)
  wsd adapter list               list adapter manifests found on relays
  wsd events export [file]       dump signed event log (JSONL — commit to any git forge)
  wsd events import <file> [--relay]  ingest events from any transport; --relay gossips onward
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
      if (r.stored === 0) {
        const { queueSighting } = await import("./node.mjs");
        await queueSighting(sight);
        console.log(`published ${r.event.id} → ACK'd but not retained; queued for retry`);
      } else {
        console.log(`published ${r.event.id} → verified on ${r.stored} relay copy(ies)`);
      }
    } catch (e) {
      const { queueSighting } = await import("./node.mjs");
      await queueSighting(sight);
      console.log(`queued for retry (relays unreachable): ${e.message}`);
    }
    closePool(); setTimeout(()=>process.exit(0),300); break;
  }
  case "flush": {
    needId();
    const { flushOutbox, loadOutbox } = await import("./node.mjs");
    const pending = loadOutbox().length;
    if (!pending) { console.log("outbox empty"); break; }
    const n = await flushOutbox();
    console.log(`flushed ${n}/${pending} queued sightings (pipelined batch publish + retention verify)`);
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
  case "cdp-watch": {
    const { cdpWatchCli } = await import("./cdp-watch.mjs");
    await cdpWatchCli(a);
    closePool(); setTimeout(()=>process.exit(0),300);
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
  case "snapshot": {
    needId();
    const idx = loadIndex();
    const byPlatform = {}, byTier = {};
    let n = 0;
    for (const s of Object.values(idx.sightings)) {
      n++; byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1;
      const t = s.tier ?? "lead"; byTier[t] = (byTier[t] ?? 0) + 1;
    }
    const { capacitySnapshotEventTemplate } = await import("./core.mjs");
    const { publish } = await import("./node.mjs");
    const id = loadIdentity();
    const r = await publish(capacitySnapshotEventTemplate(id.pk, {
      v: 1, sightings: n, by_platform: byPlatform, by_tier: byTier,
      watermark: idx.watermark ?? null, at: Math.floor(Date.now() / 1000),
    }));
    console.log(`snapshot published: ${n} sightings, ${r.oks.length} relays`);
    closePool(); setTimeout(()=>process.exit(0),300); break;
  }
  case "meta": {
    // Collective governance: publish/fetch threshold-ratified protocol
    // parameter payloads (see proto.mjs). `wsd meta publish payload.json`
    // signs the payload with THIS key — ratification needs ≥threshold
    // distinct keys from the payload's required steward set, so each
    // steward runs it once.
    const sub = pos[0];
    if (sub === "publish") {
      needId();
      const file = pos[1] ?? a.file;
      if (!file) { console.error("usage: wsd meta publish <payload.json>"); process.exit(1); }
      const payload = parseMetaPayload(JSON.parse(readFileSync(file, "utf8")));
      if (!payload) { console.error("invalid meta payload — see proto.mjs schema"); process.exit(1); }
      const id = loadIdentity();
      const r = await publish(metaEventTemplate(id.pk, payload));
      console.log(`meta seq=${payload.seq} published by ${id.pk.slice(0, 12)}… → ${r.stored ?? "?"} relay copy(ies) stored`);
      console.log(`ratification needs ≥${payload.threshold} of [${(payload.seq === 0 ? payload.stewards : (payload.prev_stewards ?? payload.stewards)).map((s) => s.slice(0, 8)).join(", ")}]`);
    } else if (sub === "fetch" || !sub) {
      const { verifyEvent } = await import("nostr-tools");
      const evs = await query({ kinds: [30078], "#t": [T_PROTOCOL_META], limit: Number(a.limit) });
      const best = ratifyMeta(evs, verifyEvent);
      if (best) {
        console.log(`ratified meta seq=${best.seq} signers=${best.signers.length}/${best.payload.threshold}`);
        console.log(JSON.stringify(best.payload, null, 2));
        if (a.apply) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { homedir } = await import("node:os");
          const { join } = await import("node:path");
          const dir = join(homedir(), ".widespread-discovery");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "protocol-meta.json"), JSON.stringify(best.payload, null, 2));
          console.log("applied: relay_hints now override defaults (WSD_RELAYS still wins)");
        }
      } else {
        // show per-payload ratification progress so stewards see what's missing
        const groups = new Map();
        for (const ev of evs) { const l = groups.get(ev.content) ?? []; l.push(ev); groups.set(ev.content, l); }
        for (const [content, list] of groups) {
          const p = parseMetaPayload(content);
          if (!p) continue;
          const req = new Set(p.seq === 0 ? p.stewards : (p.prev_stewards ?? p.stewards));
          const signers = new Set(list.filter((e) => verifyEvent(e) && req.has(e.pubkey)).map((e) => e.pubkey));
          console.log(`seq=${p.seq} signers=${signers.size}/${p.threshold} ${signers.size >= p.threshold ? "RATIFIED" : "pending"}`);
        }
        if (!groups.size) console.log("no protocol-meta events found on relays");
      }
    } else { console.error(`unknown meta subcommand: ${sub}`); process.exit(1); }
    closePool(); setTimeout(() => process.exit(0), 300); break;
  }
  case "adapter": {
    const sub = pos[0];
    if (sub === "publish") {
      needId();
      const file = pos[1] ?? a.file;
      if (!file) { console.error("usage: wsd adapter publish <manifest.json>"); process.exit(1); }
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (!manifest?.id) { console.error("manifest missing id"); process.exit(1); }
      const id = loadIdentity();
      const r = await publish(adapterEventTemplate(id.pk, manifest));
      console.log(`adapter ${manifest.id} published → ${r.stored ?? "?"} relay copy(ies) stored`);
    } else if (sub === "list" || !sub) {
      const evs = await query({ kinds: [30078], "#t": [T_ADAPTER], limit: Number(a.limit) });
      const ads = collectAdapters(evs);
      for (const [id, rec] of ads) {
        const m = rec.manifest;
        console.log(`${id}  ${m.platform ?? m.family ?? "?"}  ops=${m.ops?.length ?? 0}  by ${rec.pubkey.slice(0, 8)}…`);
      }
      console.log(`— ${ads.size} adapters from ${evs.length} events`);
    } else { console.error(`unknown adapter subcommand: ${sub}`); process.exit(1); }
    closePool(); setTimeout(() => process.exit(0), 300); break;
  }
  case "events": {
    // Transport-agnostic event log — signed envelopes ride ANY git forge
    // or file transport; relays are accelerators, not infrastructure.
    const sub = pos[0];
    if (sub === "export") {
      const { writeFileSync } = await import("node:fs");
      const evs = readEventLog();
      const out = pos[1] ?? a.file ?? "events.jsonl";
      writeFileSync(out, evs.map((e) => JSON.stringify(e)).join("\n") + (evs.length ? "\n" : ""));
      console.log(`exported ${evs.length} events → ${out}`);
      console.log(`commit it to any git forge (GitHub/GitLab/Forgejo/Tangled/Radicle) — watchers pull it back with \`wsd events import\``);
    } else if (sub === "import") {
      const file = pos[1] ?? a.file;
      if (!file) { console.error("usage: wsd events import <file.jsonl> [--relay]"); process.exit(1); }
      const { readFileSync } = await import("node:fs");
      const evs = readFileSync(file, "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const { sightings, other } = await ingestEnvelopes(evs);
      console.log(`imported ${evs.length} envelopes: ${sightings} new sightings indexed, ${other.length} non-sighting events`);
      if (a.relay && other.length) {
        // gossip meta/adapter/snapshot envelopes onward — signatures are
        // preserved verbatim so provenance is untouched
        let ok = 0, fail = 0;
        for (const ev of other) {
          try { await publishRawEvent(ev); ok++; } catch { fail++; }
        }
        console.log(`gossip: ${ok} relayed, ${fail} failed`);
      }
    } else { console.error(`unknown events subcommand: ${sub} (export|import)`); process.exit(1); }
    closePool(); setTimeout(() => process.exit(0), 300); break;
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
