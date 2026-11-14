// format.ts — display helpers shared by every page. Pure functions over
// feed/mirror/claim shapes; no I/O.

import type { FeedRecord, MirrorListing } from "../types";
import { esc } from "./shell";

export { esc };

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 1000 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                  : `$${n.toFixed(2)}`;
}

export function fmtAmount(amount?: string, currency?: string): string {
  if (!amount) return "—";
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return esc(amount);
  const cur = (currency ?? "").toUpperCase();
  if (cur === "USD") return fmtUsd(n);
  if (cur === "NEAR") return `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} NEAR`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${esc(cur)}`;
}

export function timeAgo(ms?: number): string {
  if (!ms) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function shortHash(h?: string, n = 10): string {
  if (!h) return "—";
  return h.length > n * 2 + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : esc(h);
}

/** Forge badge label from record.forge / record.source. */
export function forgeLabel(rec: FeedRecord | MirrorListing): string {
  const f = (rec as FeedRecord).forge;
  if (f) return f;
  const src = (rec as MirrorListing).record_id ?? "";
  const m = src.match(/github-thirdparty:[^:]+:([^/]+)\//);
  if (m) return m[1];
  return "generic";
}

/** Canonical homepage for every forge/platform we surface — badges link out. */
const SITE_URLS: Record<string, string> = {
  github: "https://github.com", gitlab: "https://gitlab.com", forgejo: "https://forgejo.org",
  tangled: "https://tangled.org", radicle: "https://radicle.xyz", codeberg: "https://codeberg.org",
  gitea: "https://about.gitea.com", algora: "https://algora.io", opire: "https://opire.dev",
  immunefi: "https://immunefi.com", devto: "https://dev.to", hashnode: "https://hashnode.com",
  bluesky: "https://bsky.app", bsky: "https://bsky.app", mastodon: "https://joinmastodon.org",
  lemmy: "https://join-lemmy.org", misskey: "https://misskey-hub.net",
  pixelfed: "https://pixelfed.org", peertube: "https://joinpeertube.org", nostr: "https://nostr.com",
  hive: "https://hive.io", steem: "https://steem.com", wordpress: "https://wordpress.org",
  blogger: "https://www.blogger.com", substack: "https://substack.com", audius: "https://audius.co",
  kick: "https://kick.com", youtube: "https://www.youtube.com", x: "https://x.com",
  twitter: "https://x.com", linkedin: "https://www.linkedin.com", tiktok: "https://www.tiktok.com",
  gnosis: "https://www.gnosis.io", near: "https://near.org", ipfs: "https://ipfs.tech",
  activitypub: "https://activitypub.rocks", hackernews: "https://news.ycombinator.com",
  hn: "https://news.ycombinator.com",
};

/** Resolve a forge/platform label ("GitHub", "devto", "forge-thirdparty:x") to its site URL. */
export function siteUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SITE_URLS[key] ?? null;
}

export function forgeBadge(rec: FeedRecord | MirrorListing): string {
  const label = forgeLabel(rec);
  const url = siteUrl(label);
  return url
    ? `<a class="forge-badge" href="${url}" target="_blank" rel="noopener" title="${esc(label)}">${esc(label)}</a>`
    : `<span class="forge-badge">${esc(label)}</span>`;
}

/** Map a feed source to the third-party platform name for "also on" badges. */
export function platformOf(rec: FeedRecord | MirrorListing): string | null {
  const s = (rec as FeedRecord).source;
  if (!s) return null;
  const m = s.match(/github-thirdparty:([a-z]+)/);
  if (m) return m[1] === "generic" ? null : m[1];
  const ext = s.match(/^(?:external|forge-thirdparty):(.+)$/);
  return ext ? ext[1] : null;
}

/** Escrow-state → pill. States come from FeedRecord.escrow.state and
 * MirrorListing.status — normalize both into one vocabulary. */
export function escrowPill(rec: FeedRecord | MirrorListing): { cls: string; label: string } {
  const m = rec as MirrorListing;
  if (m.status) {
    switch (m.status) {
      case "funded": return { cls: "ok", label: "funded · escrowed" };
      default: return { cls: "warn", label: "seeking funder" };
    }
  }
  const e = (rec as FeedRecord).escrow?.state;
  switch (e) {
    case "locked": return { cls: "ok", label: "escrow locked" };
    case "external": return { cls: "info", label: "external escrow" };
    case "label-only": return { cls: "mut", label: "label only" };
    case "none": return { cls: "mut", label: "unfunded" };
    default: return { cls: "mut", label: e ?? "unknown" };
  }
}

export function pill(cls: string, label: string): string {
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

/** Pill that links out to the named platform's site in a new tab. */
export function pillSite(cls: string, label: string, site: string | null): string {
  return site
    ? `<a class="pill ${cls}" href="${site}" target="_blank" rel="noopener">${esc(label)}</a>`
    : pill(cls, label);
}

export function bountyHref(rec: FeedRecord | MirrorListing): string {
  const id = (rec as MirrorListing).id ?? (rec as FeedRecord).id;
  return `/bounties/${encodeURIComponent(id)}`;
}

export function trustLine(rec: FeedRecord): string {
  const t = rec.trust;
  if (!t) return "";
  const parts: string[] = [];
  if (t.repo_claims != null) parts.push(`<b>${t.repo_claims}</b> claims`);
  if (t.repo_paid != null) parts.push(`<b>${t.repo_paid}</b> paid`);
  if (t.repo_pass_rate != null) parts.push(`<b>${Math.round(t.repo_pass_rate * 100)}%</b> pass`);
  return parts.join(" · ");
}

export function competitionLine(rec: FeedRecord): string {
  const c = rec.competition;
  if (!c) return "";
  const parts: string[] = [];
  if (c.pending_claims != null) parts.push(`<b>${c.pending_claims}</b> pending`);
  if (c.unique_claimants != null) parts.push(`<b>${c.unique_claimants}</b> claimants`);
  if (c.first_claim_age_h != null) parts.push(`first <b>${c.first_claim_age_h}h</b> ago`);
  return parts.join(" · ");
}

/** Amount display for a card: face value + claimant share for mirrors. */
export function cardAmount(rec: FeedRecord | MirrorListing): string {
  const m = rec as MirrorListing;
  if (m.claimant_share?.est_usd != null) {
    return `<span class="amount">${fmtUsd(m.claimant_share.est_usd)}<small> winner share</small></span>
      <div class="cut" style="font-size:.75rem;color:var(--fg-faint)">face ${esc(fmtAmount(m.original?.amount, m.original?.currency))} · ${(m.cut_bps / 100).toFixed(0)}% platform cut at settlement</div>`;
  }
  const r = rec as FeedRecord;
  const amt = r.est_usd != null ? fmtUsd(r.est_usd)
    : fmtAmount(r.amount, r.currency);
  return `<span class="amount">${amt}</span>`;
}
