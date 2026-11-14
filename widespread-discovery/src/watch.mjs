// watch.mjs — surface polling: json (generic array extractor), rss, hn-algolia.
// Grammar filter: text must match /widespread/i by default (or custom regex
// passed via opts.grammar). Read-only — watchers never write to surfaces.
import { publishSighting, loadIndex, saveIndex, ingestEvents, query, queueSighting, flushOutbox, loadIdentity } from "./node.mjs";
import { textHash, dedupeKey } from "./core.mjs";
const DECL_RE = /widespread\s+(declare|bounty|task)/i;

// Collect candidate arrays; score by how post-like their elements are
// (id + text-ish field). Discourse /latest.json leads with a `users`
// array — first-match loses to `topic_list.topics` on scoring.
function findArrays(o, depth = 0, out = []) {
  if (depth > 4 || !o || typeof o !== "object") return out;
  if (Array.isArray(o)) {
    if (o.length && typeof o[0] === "object") out.push(o);
    return out;
  }
  for (const k of Object.keys(o)) findArrays(o[k], depth + 1, out);
  return out;
}

function findArray(o) {
  const cands = findArrays(o);
  const score = (arr) => arr.slice(0, 5).reduce((n, e) =>
    n + (e.id != null || e.topic_id != null ? 2 : 0)
      + (e.title || e.excerpt || e.text || e.body ? 1 : 0), 0);
  cands.sort((a, b) => score(b) - score(a));
  return cands[0] ?? null;
}

function parseRSS(xml, grammar) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/g;
  let m;
  const tag = (block, name) => {
    const r = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i");
    const hit = block.match(r);
    return hit ? hit[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
  };
  while ((m = re.exec(xml))) {
    const b = m[1];
    const text = `${tag(b, "title")} ${tag(b, "description")}`;
    if (grammar.test(text)) items.push({
      id: tag(b, "guid") || tag(b, "link"), author: tag(b, "author") || tag(b, "dc:creator"),
      text, url: tag(b, "link"), ts: undefined,
    });
  }
  return items;
}

export function extractItems(surface, body, grammar) {
  if (surface.kind === "hn" || /algolia/.test(surface.url)) {
    return (body.hits || []).map((h) => ({
      id: String(h.objectID), author: h.author,
      text: `${h.title ?? ""} ${h.url ?? ""}`.trim(),
      url: h.url ? `https://news.ycombinator.com/item?id=${h.objectID}` : undefined,
      ts: h.created_at_i,
    })).filter((i) => grammar.test(i.text));
  }
  if (surface.kind === "rss" || /<rss|<feed/.test(String(body).slice(0, 200))) {
    return parseRSS(String(body), grammar);
  }
  const arr = findArray(body);
  return (arr || []).map((o) => {
    const id = String(o.id ?? o.topic_id ?? o.native_id ?? "");
    const text = `${o.title ?? ""} ${o.excerpt ?? o.blurb ?? o.raw ?? o.text ?? o.body ?? ""}`.trim();
    const slug = o.slug ? `/${o.slug}` : "";
    return {
      id, author: o.username ?? o.user?.username ?? o.author ?? o.login,
      text, url: o.url ?? (id && surface.url.includes("discourse") ? surface.url.replace(/\/latest\.json.*|\/search\.json.*/, "") + `/t${slug}/${id}` : undefined),
      ts: o.created_at ? Math.floor(new Date(o.created_at).getTime() / 1000) : o.bumped_at ? Math.floor(new Date(o.bumped_at).getTime() / 1000) : o.created_at_i,
    };
  }).filter((i) => i.id && grammar.test(i.text));
}

const seenCache = new Set();
export async function watchOnce(surfaces, opts = {}) {
  const id = loadIdentity();
  if (!id) throw new Error("no identity — run `wsd keygen`");
  try { const f = await flushOutbox(); if (f) console.error(`flushed ${f} queued sightings`); } catch {}
  const grammar = new RegExp(opts.grammar || "widespread", "i");
  const idx = loadIndex();
  let published = 0, seen = 0;
  for (const surface of surfaces) {
    try {
      const res = await fetch(surface.url, { headers: { accept: "application/json, application/rss+xml, */*", "user-agent": "widespread-discovery/0.1" } });
      if (!res.ok) { console.error(`${surface.platform}: HTTP ${res.status}`); continue; }
      const ct = res.headers.get("content-type") ?? "";
      const body = /json/.test(ct) || surface.kind === "json" || surface.kind === "hn" ? await res.json() : await res.text();
      const items = extractItems(surface, body, grammar);
      for (const it of items) {
        seen++;
        const key = dedupeKey(surface.platform, it.id, id.pk);
        const th = await textHash(it.text);
        const sig = `${key}|${th}`;
        if (seenCache.has(sig) || idx.sightings[key]?.text_hash === th) continue;
        seenCache.add(sig);
        const sight = { platform: surface.platform, native_id: it.id, url: it.url, author: it.author, text: it.text.slice(0, 4000), ts: it.ts };
        try { await publishSighting(sight); }
        catch (e) { await queueSighting(sight); console.error(`queued (relay fail): ${surface.platform}:${it.id}`); }
        idx.sightings[key] = { platform: surface.platform, native_id: it.id, url: it.url, author: it.author, text: it.text.slice(0, 4000), ts: it.ts, watcher_id: id.pk, text_hash: th, first_seen: Date.now(), last_seen: Date.now() };
        published++;
      }
    } catch (e) { console.error(`${surface.platform}: ${e.message}`); }
  }
  // also ingest relay sightings for the local index
  try { await ingestEvents(await query({ kinds: [30078], "#t": ["widespread-sighting"], limit: 200 })); } catch {}
  saveIndex(idx);
  return { published, seen };
}
