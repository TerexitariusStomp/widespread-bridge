// userscript variant — same logic, Tampermonkey/Violentmonkey compatible.
// ==UserScript==
// @name         Widespread Watcher
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Without extension APIs this variant can only *display* sightings locally.
// For publishing, install the MV3 extension (background.js holds keys+relays)
// or use the web app / wsd CLI. This file is the credentialed-surface
// observer half: it annotates matching posts in-page.
(() => {
  const GRAMMAR = /widespread\s+(declare|bounty|task|claim|receipt|bind)/i;
  const mark = (el) => {
    if (el.dataset?.wsd) return;
    el.dataset.wsd = "1";
    const badge = document.createElement("span");
    badge.textContent = "◈ widespread";
    badge.style.cssText = "font:11px monospace;color:#58a6ff;border:1px solid #58a6ff;border-radius:8px;padding:0 6px;margin-left:8px;vertical-align:middle";
    (el.querySelector("a[href]") ?? el).after(badge);
  };
  const scan = (root) => {
    root.querySelectorAll("article, .topic, .post, .message, .comment, li, p, div").forEach((el) => {
      const t = (el.innerText || "").trim();
      if (t.length > 20 && t.length < 8000 && GRAMMAR.test(t)) mark(el);
    });
  };
  scan(document.body);
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n)))).observe(document.body, { childList: true, subtree: true });
})();
