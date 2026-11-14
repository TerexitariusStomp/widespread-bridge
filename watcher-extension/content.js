// content.js — observes the DOM of every visited page, grammar-matches
// sighting candidates, dedupes, and asks background.js to sign+publish.
// Read-only: never clicks, never submits, never touches page state.
(() => {
  const GRAMMAR = /widespread\s+(declare|bounty|task|claim|receipt|bind)/i;
  const SEEN_KEY = "wsd_seen";
  const seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
  const saveSeen = () => { const a = [...seen].slice(-2000); localStorage.setItem(SEEN_KEY, JSON.stringify(a)); };
  const platform = location.hostname;
  let observer = null;

  function candidates(root) {
    const out = [];
    const els = root.querySelectorAll("article, .topic, .post, .message, .comment, [data-testid], li, p, div");
    for (const el of els) {
      const text = (el.innerText || "").trim();
      if (text.length < 20 || text.length > 8000 || !GRAMMAR.test(text)) continue;
      // stable-ish native id: prefer data attrs / id / nearest link href
      const link = el.querySelector("a[href]");
      const href = link?.href ?? location.href;
      const native_id = (el.dataset?.id || el.id || href.split("/").filter(Boolean).pop() || href).slice(0, 200);
      const author = el.querySelector("[data-user], .author, .username, [rel=author]")?.textContent?.trim()?.slice(0, 100);
      out.push({ platform, native_id, url: href, author, text: text.slice(0, 4000), ts: Math.floor(Date.now() / 1000) });
    }
    return out;
  }

  async function scan(root = document.body) {
    if (!root) return;
    for (const c of candidates(root)) {
      const key = `${c.platform}|${c.native_id}|${c.text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key); saveSeen();
      chrome.runtime.sendMessage({ type: "wsd:sighting", sighting: c }, (r) => {
        if (chrome.runtime.lastError || r?.error) console.debug("[wsd]", r?.error ?? chrome.runtime.lastError.message);
      });
    }
  }

  function start() {
    scan();
    observer = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType === 1) scan(n);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
