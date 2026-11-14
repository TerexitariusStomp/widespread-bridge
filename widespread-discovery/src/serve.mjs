// serve.mjs — localhost HTTP API for wsd. Any language can query it;
// the daemon is an optional peer, not a required hop.
import { createServer } from "node:http";
import { loadIdentity, loadIndex, publishSighting, query, ingestEvents, publishState, fetchState, relays } from "./node.mjs";
import { watchOnce } from "./watch.mjs";
import { parseArgs } from "node:util";

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); };

export function serve({ port = 8787, surfaces = null, intervalSec = 0 } = {}) {
  const id = loadIdentity();
  if (!id) { console.error("no identity — run `wsd keygen`"); process.exit(1); }
  console.log(`wsd serve — watcher ${id.pk.slice(0, 12)}… on http://127.0.0.1:${port}`);
  if (intervalSec > 0 && surfaces?.length) {
    setInterval(() => watchOnce(surfaces).catch((e) => console.error("watch:", e.message)), intervalSec * 1000);
  }
  createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/health") return json(res, 200, { ok: true, pubkey: id.pk });
      if (u.pathname === "/api/sightings" && req.method === "GET") {
        const idx = loadIndex();
        const p = u.searchParams.get("platform"), n = u.searchParams.get("native_id"), limit = Number(u.searchParams.get("limit") ?? 200);
        let rows = Object.values(idx.sightings);
        if (p) rows = rows.filter((s) => s.platform === p);
        if (n) rows = rows.filter((s) => s.native_id === n);
        return json(res, 200, { sightings: rows.slice(-limit), count: rows.length });
      }
      if (u.pathname === "/api/sightings" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const s = JSON.parse(body || "{}");
        if (!s.platform || !s.native_id || !s.text) return json(res, 400, { error: "platform, native_id, text required" });
        const r = await publishSighting(s);
        await ingestEvents([r.event]);
        return json(res, 200, { event_id: r.event.id, oks: r.oks });
      }
      if (u.pathname === "/api/query" && req.method === "GET") {
        const filter = { kinds: [30078], "#t": ["widespread-sighting"], limit: Number(u.searchParams.get("limit") ?? 200) };
        const p = u.searchParams.get("platform");
        if (p) filter["#d"] = [`${p}:${u.searchParams.get("native_id") ?? ""}`];
        const evs = await query(filter);
        const n = await ingestEvents(evs);
        return json(res, 200, { events: evs.length, ingested: n });
      }
      if (u.pathname === "/api/stats") {
        const idx = loadIndex();
        const rows = Object.values(idx.sightings);
        const byPlatform = {}, byTier = {};
        for (const s of rows) { byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1; byTier[s.tier ?? "?"] = (byTier[s.tier ?? "?"] ?? 0) + 1; }
        return json(res, 200, { sightings: rows.length, by_platform: byPlatform, by_tier: byTier, relays: relays(), pubkey: id.pk });
      }
      if (u.pathname === "/api/state/publish" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const r = await publishState(JSON.parse(body || "{}"));
        return json(res, 200, { event_id: r.event.id });
      }
      if (u.pathname === "/api/state/fetch") {
        return json(res, 200, { state: await fetchState() });
      }
      if (u.pathname === "/api/watch" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { surfaces: surfs } = JSON.parse(body || "{}");
        const r = await watchOnce(surfs);
        return json(res, 200, r);
      }
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: e.message }); }
  }).listen(port, "127.0.0.1");
}
