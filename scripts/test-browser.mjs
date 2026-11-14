// test-browser.mjs — battle-test watcher-web + watcher-extension in real Chromium.
// Requires playwright browsers: node node_modules/playwright-core/cli.js install chromium
//   npm run test:browser          headless PWA + headful extension (needs DISPLAY)
//   npm run test:browser -- --pwa-only
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = [];
const ok = (n, d) => { rows.push(["PASS", n]); console.log(`✓ ${n}${d ? " — " + d : ""}`); };
const fail = (n, d) => { rows.push(["FAIL", n]); console.log(`✗ ${n} — ${d}`); };
const skip = (n, d) => { rows.push(["SKIP", n]); console.log(`- ${n} — ${d}`); };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".webmanifest": "application/json", ".png": "image/png", ".css": "text/css" };
const server = createServer((req, res) => {
  try {
    const p = join(root, "watcher-web", req.url === "/" ? "index.html" : req.url.split("?")[0]);
    const body = readFileSync(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import("playwright-core");

// ================= watcher-web PWA =================
{
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.NostrTools, null, { timeout: 10000 });
    ok("PWA loads generated nostr.bundle.js (window.NostrTools)");

    const sws = await page.evaluate(() => navigator.serviceWorker?.getRegistrations().then((r) => r.length) ?? 0);
    sws > 0 ? ok("PWA service worker registered", `${sws} reg`) : skip("PWA service worker", "none registered (http origin)");

    await page.click("#btn-gen");
    await page.waitForFunction(() => document.getElementById("npub").textContent.startsWith("npub1"), null, { timeout: 5000 });
    ok("PWA identity generation (btn-gen → npub)");

    await page.click("#btn-connect");
    await page.click("#btn-snapshot");
    await page.waitForFunction(
      () => /snapshot published|failed:/.test(document.getElementById("snapshot-log").textContent),
      null, { timeout: 45000 }
    );
    const snap = await page.$eval("#snapshot-log", (el) => el.textContent);
    if (snap !== "snapshot published") throw new Error(snap);
    const rlog = await page.$eval("#relay-log", (el) => el.textContent);
    if (!/verdict:retained/.test(rlog)) throw new Error(`no retained verdict in relay-log: ${rlog.slice(-120)}`);
    ok("PWA kind-30078 publish → verdict:retained (real relay)", rlog.match(/stored:\d+/)?.[0]);

    if (errors.length) throw new Error(`page errors: ${errors.join(" | ").slice(0, 200)}`);
    ok("PWA zero console/page errors");
  } catch (e) {
    fail("watcher-web PWA", String(e?.message ?? e).slice(0, 300));
  }
  await browser.close();
}

// ================= watcher-extension =================
if (process.argv.includes("--pwa-only")) {
  skip("watcher-extension", "--pwa-only");
} else {
  const ext = join(root, "watcher-extension");
  const profile = mkdtempSync(join(tmpdir(), "wsd-ext-"));
  try {
    const ctx = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run"],
    });
    // background service worker appears once the extension initializes
    let sw = null;
    for (let i = 0; i < 20 && !sw; i++) {
      sw = ctx.serviceWorkers()[0];
      if (!sw) await new Promise((r) => setTimeout(r, 500));
    }
    if (!sw) throw new Error("background service worker never started (extensions need a display — DISPLAY must be set)");
    ok("extension background service worker started", sw.url().split("/").pop());

    const hasNostr = await sw.evaluate(() => typeof self.NostrTools?.finalizeEvent === "function");
    if (!hasNostr) throw new Error("self.NostrTools missing — importScripts bundle failed");
    ok("extension importScripts nostr.bundle.js in SW context");

    const res = await sw.evaluate(async () => {
      try {
        const r = await publishSighting({ platform: "smoke-ext", native_id: `ext-${Date.now()}`, url: "https://example.test", author: "smoke", text: "extension battle test sighting" });
        return { ok: true, r };
      } catch (e) { return { ok: false, err: String(e) }; }
    });
    if (!res.ok) throw new Error(res.err);
    const oks = res.r?.oks ?? 0;
    if (oks < 1) throw new Error(`0 relays accepted: ${JSON.stringify(res.r).slice(0, 120)}`);
    ok("extension sighting published to relays", `event ${String(res.r.event_id).slice(0, 12)}… oks:${oks}`);

    await ctx.close();
  } catch (e) {
    fail("watcher-extension", String(e?.message ?? e).slice(0, 300));
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

server.close();
const fails = rows.filter((r) => r[0] === "FAIL").length;
console.log(`\n${rows.filter((r) => r[0] === "PASS").length}/${rows.length} browser checks passed`);
process.exit(fails ? 1 : 0);
