// shell.ts — page shell: topbar, footer, OG/meta, theme. Every human page
// renders through here so nav + feed links + agent-parity hints stay uniform.

import { CSS } from "./theme";
import { FX } from "./fx";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export interface ShellOpts {
  title: string;
  description?: string;
  body: string;
  /** "bounties" | "docs" | "ops" | null — active nav item */
  nav?: string | null;
  /** canonical/OG url path for unfurls */
  path?: string;
  jsonLd?: unknown;
  base?: string;
}

const NAV = [
  ["/docs", "Docs", "docs"],
] as const;

export function pageShell(o: ShellOpts): string {
  const base = o.base ?? "https://widespread.fyi";
  const canonical = o.path ? `${base}${o.path}` : "";
  const nav = NAV.map(([href, label, key]) =>
    `<a href="${href}"${o.nav === key ? ' class="active"' : ""}>${label}</a>`).join("");
  const ld = o.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, "\\u003c")}</script>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0b0e">
<title>Widespread</title>
<link rel="icon" type="image/png" href="/icon.png">
<link rel="apple-touch-icon" href="/icon-400.png">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta name="description" content="${esc(o.description ?? "Verified work, paid — bounty markets and escrow across every forge and work surface. Unified feed, public receipts.")}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description ?? "")}">
<meta property="og:type" content="website">
<meta property="og:image" content="${base}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${base}/og.png">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="alternate" type="text/markdown" href="${base}/feed.md" title="Bounty feed (markdown)">
<link rel="alternate" type="application/rss+xml" href="${base}/api/feed.rss" title="Bounty feed (RSS)">
<style>${CSS}</style>
${ld}
</head>
<body>
<header class="topbar"><div class="topbar-inner">
  <a class="brand" href="/"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29.5" fill="none" stroke="currentColor" stroke-width="4"/><g stroke="currentColor" stroke-width="4.4" stroke-linecap="round"><line x1="32" y1="32" x2="32" y2="13"/><line x1="32" y1="32" x2="49.2" y2="22.5"/><line x1="32" y1="32" x2="49.2" y2="41.5"/><line x1="32" y1="32" x2="32" y2="51"/><line x1="32" y1="32" x2="14.8" y2="41.5"/><line x1="32" y1="32" x2="14.8" y2="22.5"/></g><g fill="currentColor"><circle cx="32" cy="11.5" r="6.2"/><circle cx="50.4" cy="21.8" r="6.2"/><circle cx="50.4" cy="42.2" r="6.2"/><circle cx="32" cy="52.5" r="6.2"/><circle cx="13.6" cy="42.2" r="6.2"/><circle cx="13.6" cy="21.8" r="6.2"/></g><circle cx="32" cy="32" r="14" fill="currentColor"/><circle cx="32" cy="32" r="5.6" fill="var(--bg)"/></svg>Widespread<span class="dot">.</span><small>empowering you</small></a>
  <nav class="main">${nav}</nav>
  <a class="connect" href="https://t.me/widespreadfyi" target="_blank" rel="noopener">Connect</a>
  <span class="spacer"></span>
  <span class="feed-link">API · MCP · RSS — agents welcome</span>
</div></header>
<main>${o.body}</main>
<footer><div class="inner">
  <span>Widespread — empowering you</span>
  <a href="/api/feed">/api/feed</a>
  <a href="/feed.md">feed.md</a>
  <a href="/api/feed.rss">RSS</a>
  <a href="/llms.txt">llms.txt</a>
  <a href="https://github.com/TerexitariusStomp/widespread-bridge" rel="noopener">GitHub</a>
  <a href="/mcp">MCP</a>
  <a href="/docs">docs</a>
  <a href="/security">security</a>
  <a href="/faq">faq</a>
  <a href="/brand">brand</a>
  <span style="margin-left:auto">face value · platform cut at settlement · receipts on-chain</span>
</div></footer>
${FX}
</body>
</html>`;
}

export function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init?.headers ?? {}) },
  });
}
