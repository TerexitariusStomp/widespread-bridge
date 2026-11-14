// ==UserScript==
// @name         Widespread Watcher
// @namespace    widespread
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==
//
// Credentialed-surface watcher (userscript tier). Runs in page context with
// the user's session — GM_xhr bypasses CORS but NEVER exposes cookies:
// credentials stay in the browser; only grammar-matched sighting fields
// leave, posted to the bridge (or held locally if bridge unset).
// Configure via GM menu values or the CONFIG block below.

const CONFIG = {
  // surfaces this script watches on THIS site — api ops resolve here only
  // (trifecta: no agent-chosen URLs; user edits this file to add surfaces)
  surfaces: [],          // [{platform, base_url, api:{op:"/path/{id}"}}]
  grammar: /widespread\s+(declare|bounty|task|claim|receipt|bind)/i,
  bridge: "",            // e.g. https://widespread-bridge.widespread.workers.dev — empty = local only
  poll_ms: 60000,
};

const seen = new Set(GM_getValue("wsd_seen", []));
const saveSeen = () => GM_setValue("wsd_seen", [...seen].slice(-2000));

function gmFetch(url) {
  return new Promise((res, rej) => GM_xmlhttpRequest({
    method: "GET", url, credentials: "include",
    headers: { accept: "application/json, */*" },
    onload: (r) => res(r), onerror: rej, ontimeout: rej,
  }));
}

// surface api ops — declared in CONFIG.surfaces only
async function execOp(cfg, op, params = {}) {
  const tmpl = cfg.api?.[op];
  if (!tmpl) return null;
  let path = tmpl;
  for (const [k, v] of Object.entries(params)) path = path.split(`{${k}}`).join(encodeURIComponent(v));
  if (path.includes("{")) return null;
  const url = path.startsWith("/") ? cfg.base_url.replace(/\/$/, "") + path : path;
  try { if (!["https:", "http:"].includes(new URL(url).protocol)) return null; } catch { return null; }
  const r = await gmFetch(url);
  return { status: r.status, body: (r.responseText || "").replace(/("(?:cookie|set-cookie|authorization|x-api-key|token|session|password|secret)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"').slice(0, 64000) };
}

async function publish(sighting) {
  if (!CONFIG.bridge) return; // local-only mode: sightings stay in-page
  await new Promise((res) => GM_xmlhttpRequest({
    method: "POST", url: `${CONFIG.bridge}/api/sightings`,
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ sightings: [sighting] }),
    onload: res, onerror: res, ontimeout: res,
  }));
}

// ---- DOM observation (credentialed pages) ----
function scanDom() {
  document.querySelectorAll("article, .topic, .post, .message, .comment, li, p, div").forEach((el) => {
    const text = (el.innerText || "").trim();
    if (text.length < 20 || text.length > 8000 || !CONFIG.grammar.test(text)) return;
    const link = el.querySelector("a[href]");
    const href = link?.href ?? location.href;
    const key = `${location.hostname}|${href}|${text.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key); saveSeen();
    const badge = document.createElement("span");
    badge.textContent = "◈ widespread";
    badge.style.cssText = "font:11px monospace;color:#58a6ff;border:1px solid #58a6ff;border-radius:8px;padding:0 6px;margin-left:8px";
    el.appendChild(badge);
    publish({
      platform: `web:${location.hostname}`, native_id: (el.dataset?.id || href).slice(0, 200),
      url: href, author: el.querySelector("[data-user],.author,.username")?.textContent?.trim()?.slice(0, 100),
      text: text.slice(0, 4000), ts: Math.floor(Date.now() / 1000),
    });
  });
}

// ---- api watchers: poll declared surface ops on an interval ----
async function pollSurfaces() {
  for (const cfg of CONFIG.surfaces) {
    for (const [op] of Object.entries(cfg.api ?? {})) {
      try {
        const r = await execOp(cfg, op);
        if (!r || r.status !== 200) continue;
        // grammar-match response text; sightings from API content too
        const matches = r.body.match(/.{0,200}widespread\s+(declare|bounty|task|claim|receipt|bind).{0,3800}/gi) ?? [];
        for (const m of matches.slice(0, 10)) {
          const key = `${cfg.platform}|${op}|${m.slice(0, 60)}`;
          if (seen.has(key)) continue;
          seen.add(key); saveSeen();
          await publish({ platform: cfg.platform, native_id: `${op}:${key.slice(-40)}`, url: cfg.base_url, text: m.trim(), ts: Math.floor(Date.now() / 1000) });
        }
      } catch { /* surface unreachable — skip */ }
    }
  }
}

scanDom();
new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && scanDom()))).observe(document.body, { childList: true, subtree: true });
if (CONFIG.surfaces.length) setInterval(pollSurfaces, CONFIG.poll_ms);
