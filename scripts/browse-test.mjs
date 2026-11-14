// ext-browse-test: load unpacked extension, browse a page containing a
// `widespread declare` sighting, verify the content-script → background →
// relay pipeline lands a real kind-30078.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = "/home/shredder/Documents/widespread-bridge/watcher-extension";
const MARK = `browse-${Date.now()}`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><body>
    <article id="post-42">
      <p><span class="author">battle-tester</span> widespread declare task: refactor the escrow adapter — bounty 5 NEAR — ${MARK}</p>
    </article>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/listing`;
console.log("serving declaration page at", url, "mark:", MARK);

const { chromium } = await import("playwright-core");
const profile = mkdtempSync(join(tmpdir(), "wsd-browse-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
});

let sw = null;
for (let i = 0; i < 20 && !sw; i++) { sw = ctx.serviceWorkers()[0]; if (!sw) await new Promise(r => setTimeout(r, 500)); }
if (!sw) { console.log("FAIL: no service worker"); process.exit(1); }

const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000); // content script scan + background publish

// verify on relay: query recent sightings and look for our mark
const N = await import("/home/shredder/Documents/widespread-bridge/widespread-discovery/vendor/nostr-tools.bundle.mjs");
const pool = new N.SimplePool();
let found = null;
for (let i = 0; i < 6 && !found; i++) {
  const evs = await pool.querySync(["wss://widespread-relay.widespread.workers.dev"], { kinds: [30078], "#t": ["widespread-sighting"], "#platform": ["127.0.0.1"], limit: 20 });
  found = evs.find((e) => e.content.includes(MARK));
  if (!found) await new Promise(r => setTimeout(r, 3000));
}
pool.close(["wss://widespread-relay.widespread.workers.dev"]);

await ctx.close(); server.close(); rmSync(profile, { recursive: true, force: true });
if (found) {
  console.log("PASS: extension browse-test — sighting retained on relay, id", found.id.slice(0, 16), "…");
  const c = JSON.parse(found.content);
  console.log("  platform:", c.platform, "| author:", c.author, "| native_id:", c.native_id);
} else {
  console.log("FAIL: no sighting with mark", MARK, "on relay");
  process.exit(1);
}
