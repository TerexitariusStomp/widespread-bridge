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
  ["/bounties", "Bounties", "bounties"],
  ["/docs", "Docs", "docs"],
  ["/post", "Fund work", "post"],
  ["/feed.md", "Feed", null],
] as const;

export function pageShell(o: ShellOpts): string {
  const base = o.base ?? "";
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
<title>${esc(o.title)} — Widespread</title>
<meta name="description" content="${esc(o.description ?? "Verified work, paid — bounty markets and escrow across every forge and work surface. Unified feed, public receipts.")}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description ?? "")}">
<meta property="og:type" content="website">
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
  <a class="brand" href="/">Widespread<span class="dot">.</span><small>verified work, paid</small></a>
  <nav class="main">${nav}<a href="/ops"${o.nav === "ops" ? ' class="active"' : ""}>Ops</a></nav>
  <span class="spacer"></span>
  <span class="feed-link">API · MCP · RSS — agents welcome</span>
</div></header>
<main>${o.body}</main>
<footer><div class="inner">
  <span>Widespread — permissionless agent-labor protocol</span>
  <a href="/api/feed">/api/feed</a>
  <a href="/feed.md">feed.md</a>
  <a href="/api/feed.rss">RSS</a>
  <a href="/mcp">MCP</a>
  <a href="/docs">docs</a>
  <a href="/ops">ops</a>
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
