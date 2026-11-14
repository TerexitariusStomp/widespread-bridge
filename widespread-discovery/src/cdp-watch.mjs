// cdp-watch.mjs — P3: watch surfaces through the user's real browser via CDP.
// Attaches with playwright-core connectOverCDP (Apache-2.0) to a browser
// started with --remote-debugging-port (Chrome 136+ allows the default
// profile via chrome://inspect remote debugging). Reads network responses
// inside the authenticated session — credentials never leave the browser.
// Egress stays allowlisted: only surfaces declared via `wsd surface add`
// are observed; sightings publish through the same signed protocol.
import { chromium } from "playwright-core";
import { publishSighting, loadIndex, saveIndex, ingestEvents, query, queueSighting, flushOutbox, loadIdentity, assertAllowlisted } from "./node.mjs";
import { textHash, dedupeKey } from "./core.mjs";
import { extractItems } from "./watch.mjs";

const CDP_URL = process.env.WSD_CDP_URL || "http://127.0.0.1:9222";

export async function watchViaCdp(surface, { grammar, once = false, timeoutMs = 60_000, identity } = {}) {
  const id = identity ?? loadIdentity();
  if (!id) throw new Error("no identity — run `wsd keygen` first");
  assertAllowlisted([surface]); // trifecta §8: declared surfaces only
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) { await browser.close(); return { ok: false, error: "no browser context" }; }
  const page = ctx.pages()[0] ?? await ctx.newPage();

  const pattern = surface.url.replace(/\/+$/, "");
  const idx = loadIndex();
  const published = [];
  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (!url.startsWith(pattern)) return;
      const ct = res.headers()["content-type"] ?? "";
      if (!/json|rss|atom|xml/i.test(ct)) return;
      const body = /json/i.test(ct) ? await res.json().catch(() => null) : await res.text().catch(() => null);
      if (!body) return;
      for (const it of await extractItems({ ...surface, url: pattern }, body, grammar)) {
        const key = dedupeKey(surface.platform, it.id, id.pk);
        const th = await textHash(it.text);
        if (idx.sightings[key]?.text_hash === th) continue;
        const sight = {
          platform: surface.platform, native_id: it.id, url: it.url ?? url,
          author: it.author, text: String(it.text ?? "").slice(0, 4000),
          ts: it.ts ?? Math.floor(Date.now() / 1000),
        };
        try {
          const r = await publishSighting(sight);
          if (r.stored === 0) await queueSighting(sight); // silent drop → retry later
        }
        catch { await queueSighting(sight); }
        await new Promise((r) => setTimeout(r, 250)); // pace bursts — flood filters trip on event/sec
        idx.sightings[key] = { ...sight, watcher_id: id.pk, text_hash: th, first_seen: Date.now(), last_seen: Date.now() };
        published.push(sight);
      }
    } catch { /* per-response isolation */ }
  };
  page.on("response", onResponse);

  await page.goto(surface.url.startsWith("http") ? surface.url : `https://${surface.url}`,
    { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(once ? 5_000 : timeoutMs);
  page.off("response", onResponse);
  await browser.close();
  try { await ingestEvents(await query({ kinds: [30078], "#t": ["widespread-sighting"], limit: 200 })); } catch {}
  saveIndex(idx);
  return { ok: true, sightings: published };
}

export async function cdpWatchCli(a) {
  if (!a.platform || !a.surface) { console.error("usage: wsd cdp-watch --platform web --surface URL (must be allowlisted)"); process.exit(1); }
  const grammar = a.grammar ? new RegExp(a.grammar, "i") : /widespread/i;
  try { await flushOutbox(); } catch {}
  const r = await watchViaCdp(
    { url: a.surface, platform: a.platform, kind: "web" },
    { grammar, once: !!a.once, timeoutMs: +(a.timeout ?? 60_000) },
  ).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { console.error(`cdp-watch: ${r.error} — start browser with --remote-debugging-port=9222 or WSD_CDP_URL`); process.exit(1); }
  console.log(`cdp-watch: ${r.sightings.length} sighting(s)`);
  for (const s of r.sightings) console.log(`  ${s.platform}:${s.native_id} ${s.url ?? ""}`);
}
