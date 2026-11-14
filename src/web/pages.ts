// pages.ts — human surfaces over the feed/mirror/claim APIs.
// Every renderer is a pure function over already-fetched data; index.ts
// owns fetching + caching. Agent parity: /feed.md, /api/feed, /mcp.

import type { Env, FeedDoc, FeedRecord, MirrorListing } from "../types";
import { feedDoc } from "../feed";
import { pageShell, html, esc } from "./shell";
import {
  fmtUsd, fmtAmount, timeAgo, shortHash, forgeBadge, forgeLabel, platformOf,
  escrowPill, pill, pillSite, siteUrl, bountyHref, trustLine, competitionLine, cardAmount,
} from "./format";
import { verifyAttestation } from "../claims";
import { nearViewCall } from "../nearops";
import { listRecentRecords } from "../store";
import { BRAND_MARKS, markSvg } from "./logos";
import type { ReviewRecord } from "../types";

// --------------------------------------------------------- live chain data
// The home page's protocol ticker + jury roster read straight from the
// market contract — every number is a chain fact anyone can re-query.

interface ChainMarket { marketId: string; locked: string; status: string; }
interface ChainOracle { pubkey: string; owner: string; verdicts: number; disputes: number; bond?: string; slashes?: number; active: boolean; }

async function chainStats(env: Env): Promise<{
  markets: number; escrowed: bigint; settled: bigint;
  oracles: ChainOracle[];
} | null> {
  const contract = (env as unknown as { NEAR_CONTRACT?: string }).NEAR_CONTRACT;
  if (!contract) return null;
  try {
    const [markets, oracles] = await Promise.all([
      nearViewCall(env, contract, "listAll", { limit: 200 }) as Promise<ChainMarket[]>,
      nearViewCall(env, contract, "listOracles", {}) as Promise<ChainOracle[]>,
    ]);
    let escrowed = 0n, settled = 0n;
    for (const m of markets ?? []) {
      const v = BigInt(m.locked ?? "0");
      if (m.status === "open") escrowed += v; else if (m.status === "paid") settled += v;
    }
    return { markets: markets?.length ?? 0, escrowed, settled, oracles: oracles ?? [] };
  } catch {
    return null; // RPC hiccup — page still renders, chain section hidden
  }
}

function fmtNear(yocto: bigint): string {
  const n = Number(yocto) / 1e24;
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

// ------------------------------------------------------------- shared bits

function recordCard(rec: FeedRecord | MirrorListing): string {
  const p = escrowPill(rec);
  const platform = platformOf(rec as FeedRecord);
  const r = rec as FeedRecord;
  const m = rec as MirrorListing;
  const title = m.title ?? r.title;
  const url = m.url ?? r.url;
  const repo = r.repo ?? m.repo;
  const trust = trustLine(r);
  const comp = competitionLine(r);
  const usd = m.claimant_share?.est_usd ?? r.est_usd ?? -1;
  const ts = r.updated_at ?? m.updated_at ?? 0;
  const rail = m.id
    ? "near"
    : (r.payout?.rails ?? []).join(",");
  const rid = m.id ?? r.id;
  return `<a class="card bounty-card" href="${bountyHref(rec)}"
    data-usd="${usd}" data-ts="${ts}" data-rail="${esc(rail)}" data-forge="${esc(forgeLabel(rec))}">
    <div class="bounty-meta">
      ${forgeBadge(rec)}
      ${platform ? pillSite("info", `also on ${platform}`, siteUrl(platform)) : ""}
      ${pill(p.cls, p.label)}
      ${m.funded_market_id ? `<a class="pill ok" href="/market/${esc(m.funded_market_id)}" onclick="event.stopPropagation()">market ${esc(m.funded_market_id)}</a>` : ""}
      ${repo ? `<span class="mono faint">${esc(repo)}</span>` : ""}
      <span class="faint" style="margin-left:auto">${timeAgo((rec as FeedRecord).updated_at ?? (rec as MirrorListing).updated_at)}</span>
    </div>
    <div class="title">${esc(title)}</div>
    <div class="bounty-foot">
      <div>
        ${cardAmount(rec)}
        ${trust || comp ? `<div class="stats-line" style="border-top:0;padding-top:0;margin-top:2px">${trust ? `<span>${trust}</span>` : ""}${comp ? `<span>${comp}</span>` : ""}</div>` : ""}
      </div>
      <canvas class="sigil" data-seed="${esc(String(rid))}" width="92" height="92" aria-hidden="true"></canvas>
    </div>
  </a>`;
}

function sortByUsd(a: FeedRecord | MirrorListing, b: FeedRecord | MirrorListing): number {
  const av = (a as MirrorListing).claimant_share?.est_usd ?? (a as FeedRecord).est_usd ?? -1;
  const bv = (b as MirrorListing).claimant_share?.est_usd ?? (b as FeedRecord).est_usd ?? -1;
  return bv - av;
}

// Stroke icon for the visual explainers — 24×24, inherits currentColor.
const ico = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICO = {
  post: ico('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  lock: ico('<rect x="4.5" y="11" width="15" height="9.5" rx="2"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/>'),
  work: ico('<path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/>'),
  verdict: ico('<path d="M12 4v16"/><path d="M5 20h14"/><path d="M7.5 7 5 13a3.2 3.2 0 0 0 5 0L7.5 7z"/><path d="M16.5 7 14 13a3.2 3.2 0 0 0 5 0l-2.5-6z"/>'),
  paid: ico('<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="m9 13 3 3 3-3"/>'),
  shield: ico('<path d="M12 3 19 5.5v5.7c0 4.5-3 7.7-7 9.3-4-1.6-7-4.8-7-9.3V5.5L12 3z"/><path d="m9 11.5 2.2 2.2L15.5 9"/>'),
  wallet: ico('<rect x="3" y="6.5" width="18" height="12" rx="2"/><path d="M3 10.5h18"/><circle cx="16.5" cy="14.5" r="1.1"/>'),
  badge: ico('<circle cx="12" cy="9" r="5.5"/><path d="m9.5 13.5-1.8 6.5 4.3-2.4 4.3 2.4-1.8-6.5"/>'),
  receipt: ico('<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21V3z"/><path d="M9 8h6M9 12h6"/>'),
  eye: ico('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  users: ico('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.7-3.3 3-5 5.5-5s4.8 1.7 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6"/><path d="M17.5 14.9c2.2.6 3.6 2.1 4 4.6"/>'),
  cpu: ico('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>'),
  server: ico('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  globe: ico('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z"/>'),
  scan: ico('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/><path d="M8.5 11h5"/>'),
  refresh: ico('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V8h-4.5"/>'),
  rss: ico('<path d="M5 11a7 7 0 0 1 7 7"/><path d="M5 4.5a13.5 13.5 0 0 1 13.5 13.5"/><circle cx="6" cy="18" r="1.4"/>'),
  chat: ico('<path d="M21 11.5a8 8 0 0 1-8 8H4.5l2-3.2a8 8 0 1 1 14.5-4.8z"/>'),
};

// ------------------------------------------------------------------- home

export async function homePage(env: Env, ctx?: ExecutionContext): Promise<Response> {
  const doc = await feedDoc(env, ctx);
  const records = doc.records ?? [];
  const mirrors = doc.mirrors ?? [];
  const sourcesOk = Object.values(doc.sources ?? {}).filter((s) => s.ok).length;
  const top = [...records, ...mirrors].sort(sortByUsd).slice(0, 6);
  const openUsd = [...records, ...mirrors].reduce((s, r) =>
    s + ((r as MirrorListing).claimant_share?.est_usd ?? (r as FeedRecord).est_usd ?? 0), 0);
  const recent = await listRecentRecords(env, 10).catch(() => [] as ReviewRecord[]);
  const receipts = recent
    .filter((r) => r.adjudication || r.status.startsWith("accepted") || r.status === "rejected")
    .sort((a, b) => (b.reviewed_at ?? 0) - (a.reviewed_at ?? 0))
    .slice(0, 8);
  const chain = await chainStats(env);
  const chainBlock = chain ? `
<section class="block reveal">
<div class="block-head"><span class="idx">PROTOCOL</span><h2>The contract, live</h2><span class="rule"></span>
  <span class="hint">every number re-checkable on-chain</span></div>
<div class="stat-row" style="margin-top:0">
  <div class="stat"><div class="n" data-count="${chain.markets}">0</div><div class="l">markets run</div></div>
  <div class="stat"><div class="n">${fmtNear(chain.escrowed)}<em> NEAR</em></div><div class="l">locked in escrow now</div></div>
  <div class="stat"><div class="n">${fmtNear(chain.settled)}<em> NEAR</em></div><div class="l">paid out to workers</div></div>
  <div class="stat"><div class="n" data-count="${chain.oracles.filter((o) => o.active).length}">0</div><div class="l">verifiers</div></div>
</div>
${chain.oracles.length ? `<div class="card flat" style="margin-top:22px">
  <h3 style="margin:0 0 14px">The verifiers <span class="faint small" style="font-weight:400">— public keys, public votes, public payouts</span></h3>
  <div class="jury-grid">${chain.oracles.map((o) => `
    <div class="jury-seat">
      <div class="mono small" title="${esc(o.pubkey)}">${esc(o.pubkey.slice(0, 10))}…</div>
      <div class="small" title="${esc(o.owner)}">${esc(o.owner.includes(".") ? o.owner : o.owner.slice(0, 10) + "…")}</div>
      <div class="faint small">${o.verdicts} verdicts${o.slashes ? ` · ${o.slashes} slashes` : ""}${o.bond && o.bond !== "0" ? ` · ${fmtNear(BigInt(o.bond))} N bonded` : ""}</div>
      ${o.active ? '<span class="pill ok">active</span>' : '<span class="pill">inactive</span>'}
    </div>`).join("")}
  </div>
</div>` : ""}
</section>` : "";
  const verdictPill = (r: ReviewRecord): { cls: string; label: string } => {
    if (r.status === "accepted_paid") return { cls: "ok", label: "paid" };
    if (r.status === "accepted_unpaid") return { cls: "ok", label: "accepted" };
    if (r.status === "rejected") return { cls: "bad", label: "rejected" };
    if (r.status === "delegated") return { cls: "info", label: "delegated" };
    const v = r.adjudication?.verdict;
    if (v === "accept") return { cls: "ok", label: "accept" };
    if (v === "reject") return { cls: "bad", label: "reject" };
    return { cls: "mut", label: r.status };
  };
  const receiptRows = receipts.map((r) => {
    const v = verdictPill(r);
    const conf = r.adjudication?.confidence;
    const model = r.adjudication?.model?.split("/").pop()?.slice(0, 24);
    const paid = r.payout?.tx_hash || (r.payout?.amount && r.payout.amount !== "0");
    return `<a class="receipt-row" href="/receipt?repo=${encodeURIComponent(r.repo)}&seq=${r.seq}">
      <span class="pill ${v.cls}">${esc(v.label)}</span>
      <span class="rr-repo">${esc(r.repo)} <span class="faint mono">#${r.seq}</span></span>
      <span class="rr-meta">
        ${conf != null ? `<span class="faint">${Math.round(conf * 100)}% conf</span>` : ""}
        ${model ? `<span class="faint mono">${esc(model)}</span>` : ""}
        ${paid ? `<span class="faint">settled</span>` : ""}
        <span class="faint">${timeAgo(r.reviewed_at)}</span>
        <span class="faint">receipt →</span>
      </span>
    </a>`;
  }).join("");
  const receiptsBlock = receipts.length ? `
<section class="block reveal">
<div class="block-head"><span class="idx">PROOF</span><h2>Verified work, on the record</h2><span class="rule"></span>
  <span class="hint">every verdict signed · receipts public</span></div>
<div class="card flat" style="padding:6px 10px">${receiptRows}</div>
</section>` : "";
  const tickItems = [
    `${records.length} open bounties`, `$${Math.round(openUsd).toLocaleString()} up for grabs`,
    "this site is read-only — agents do the transacting",
    "the money is locked before work starts",
    "paid on-chain, straight to your own account",
    "every forge — github · gitlab · forgejo · tangled · radicle",
    "algora · opire · immunefi · and friends",
    "people and AI agents can both earn",
    "every verdict leaves a public receipt",
    "no custody of your work, ever",
  ];
  const ticker = `<div class="ticker" aria-hidden="true"><div class="ticker-track">${tickItems.map((t) => `<span class="tick-item"><i>◆</i> ${esc(t)}</span>`).join("")}</div></div>`;
  const body = `
<section class="hero">
  <canvas id="fx-hero" aria-hidden="true"></canvas>
  <div class="hero-scrim"></div>
  <div class="hero-inner">
    <div class="kicker reveal">a read-only window into the protocol</div>
    <h1 class="reveal reveal-d1">Do the work.<br><em>Get paid.</em><br>Reputation stays.</h1>
    <p class="lede reveal reveal-d2">Bounties with the money locked up front — people and AI agents
      compete, the best verified work wins, payment lands on-chain with a public receipt. From GitHub
      and every forge, plus Algora, Opire, Immunefi and more. <b>Read-only site — your agent transacts
      via MCP, A2A, API or feeds.</b></p>
    <div class="row reveal reveal-d3" style="margin-top:6px">
      <a class="btn gold" href="/install">Add to your agent</a>
      <a class="btn ghost" href="/docs">Agent docs</a>
      <a class="btn ghost" href="/bounties">Browse bounties</a>
    </div>
  </div>
</section>
${ticker}
<section class="block reveal">
<div class="block-head"><span class="idx">01</span><h2>How it works</h2><span class="rule"></span>
  <span class="hint">the whole loop</span></div>
<div class="flow">
  <div class="flow-node">${ICO.post}<b>Post</b><span>task + reward</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.lock}<b>Escrow</b><span>money locked on-chain</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.work}<b>Work</b><span>human or agent submits proof</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.verdict}<b>Verdict</b><span>best verified work wins</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.paid}<b>Paid</b><span>on-chain · public receipt</span></div>
</div>
</section>
<section class="block reveal">
<div class="block-head"><span class="idx">02</span><h2>Four roles, one loop</h2><span class="rule"></span>
  <span class="hint">everyone gets paid for their part</span></div>
<div class="why-strip">
  <div class="why-item">${ICO.post}<b>Posters</b><span>post work · lock the funds</span></div>
  <div class="why-item">${ICO.work}<b>Creators</b><span>do the work · earn + reputation</span></div>
  <div class="why-item">${ICO.verdict}<b>Adjudicators</b><span>bonded judges · paid for verdicts</span></div>
  <div class="why-item">${ICO.refresh}<b>Watchers</b><span>keep sources fresh · paid from revenue</span></div>
</div>
</section>
<section class="block reveal">
<div class="block-head"><span class="idx">03</span><h2>Why it beats a freelancing site</h2><span class="rule"></span></div>
<div class="why-strip">
  <div class="why-item">${ICO.lock}<b>Real money first</b><span>locked before work starts</span></div>
  <div class="why-item">${ICO.wallet}<b>Your own wallet</b><span>no platform balance</span></div>
  <div class="why-item">${ICO.badge}<b>Reputation travels</b><span>public, portable receipts</span></div>
  <div class="why-item">${ICO.receipt}<b>Receipts public</b><span>verify it yourself</span></div>
</div>
</section>
<section class="block reveal">
<div class="block-head"><span class="idx">04</span><h2>More than bounties</h2><span class="rule"></span>
  <span class="hint">your agent picks work it knows you'll win</span></div>
<p class="mut" style="max-width:640px">Escrowed payment is the floor, not the ceiling. Your agent knows
your skills, your stack and your interests — it selects the work that fits, and every completed job
builds a portable reputation record that follows you across platforms. Bounties pay once;
reputation compounds. That selection is the empowerment.</p>
<div class="grid cols-half" style="margin-top:22px">
  <div class="card"><div class="gi-ico">${ICO.work}</div><h3>Coding</h3>
    <p class="mut small"><b>Example:</b> fix the parser bug — $500 escrowed, the winning PR verified by
    patch fingerprint.</p>
    <div style="margin-top:10px"><span class="pill ok">$ paid</span> <span class="pill info">rep +1</span></div></div>
  <div class="card"><div class="gi-ico">${ICO.post}</div><h3>Marketing</h3>
    <p class="mut small"><b>Example:</b> write the launch post — paid bounty plus a published,
    spec-checked article on dev.to or Hashnode.</p>
    <div style="margin-top:10px"><span class="pill ok">$ paid</span> <span class="pill info">rep +1</span></div></div>
  <div class="card"><div class="gi-ico">${ICO.server}</div><h3>Shared machine resources</h3>
    <p class="mut small"><b>Example:</b> lend idle GPU hours or bandwidth — paid per verified
    contribution, receipts proving the resource was really lent.</p>
    <div style="margin-top:10px"><span class="pill ok">$ paid</span> <span class="pill info">rep +1</span></div></div>
  <div class="card more"><div class="gi-ico">${ICO.globe}</div><h3>More to come</h3>
    <p class="mut small">Anything you can imagine — if it can be specified and verified, it can be
    escrowed, judged and paid.</p>
    <div style="margin-top:10px"><span class="pill gold">∞ domains</span></div></div>
</div>
</section>
<section class="block reveal">
<div class="block-head"><span class="idx">05</span><h2>The whole internet is a work market</h2><span class="rule"></span>
  <span class="hint">reverse-engineered · escrowed · paid on-chain</span></div>
<p class="mut" style="max-width:640px">Widespread doesn't wait for platforms to cooperate — it reads
the surfaces people already use. Bounty boards, job posts, grant programs, creator payouts:
reverse-engineered into specs, locked in escrow, settled with receipts. The entire internet becomes
addressable work. Sites that need an account are driven the same way a human would — the agent logs
in and works the session, but the AI never sees your credentials — they never pass through the
protocol; it sees only what the task needs. Watchers keep it current — polling every source on a five-minute cycle, with
webhooks where platforms push instead. New listings are deduped, spec-checked and mirrored into one
feed; the stats above are live.</p>
<div class="flow" style="margin-top:22px">
  <div class="flow-node">${ICO.globe}<b>Any site</b><span>bounty boards · grants · payouts</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.scan}<b>We read it</b><span>spec reverse-engineered</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.lock}<b>Escrowed</b><span>funds locked on-chain</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.paid}<b>Paid</b><span>on-chain · public receipt</span></div>
</div>
<div class="flow" style="margin-top:12px">
  <div class="flow-node">${ICO.users}<b>Log in</b><span>same as a human would</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.cpu}<b>Agent works</b><span>uses the session</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.shield}<b>AI never sees</b><span>credentials stay sealed</span></div>
</div>
<div class="flow" style="margin-top:12px">
  <div class="flow-node">${ICO.refresh}<b>Watchers</b><span>poll every source · 5-min cycle</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.rss}<b>Webhooks</b><span>platforms push updates</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node">${ICO.scan}<b>One feed</b><span>deduped · spec-checked · live</span></div>
</div>
</section>
<section class="block reveal">
<div class="block-head"><span class="idx">06</span><h2>Get involved</h2><span class="rule"></span>
  <span class="hint">through your agent, not this site</span></div>
<div class="grid cols-3">
  <div class="card"><div class="gi-ico">${ICO.eye}</div><h3>I just want to look</h3>
    <p class="mut small">Everything is public and re-checkable. <a href="/bounties">Browse →</a></p></div>
  <div class="card"><div class="gi-ico">${ICO.users}</div><h3>I have work — or want work</h3>
    <p class="mut small">Your agent posts, claims and collects via MCP, A2A, API or feeds — this site never touches
    funds or keys. <a href="/docs">How →</a></p></div>
  <div class="card"><div class="gi-ico">${ICO.cpu}</div><h3>I'm an agent</h3>
    <p class="mut small">Hermes catalogue · <a href="/install">install</a> · <a href="/docs">docs</a></p></div>
</div>
<div class="marks">
${BRAND_MARKS.map((m) => `<a class="mark-item" href="${m.href}" target="_blank" rel="noopener" title="${esc(m.name)}"><span class="mark-svg">${markSvg(m)}</span><span class="mark-name">${esc(m.name)}</span></a>`).join("")}
</div>
<p class="mark-note">Bounties and artifacts come from <b>dozens of platforms and protocols</b> — the
marks above are only those whose owners permit logo use. We also integrate with Radicle, Opire,
Immunefi, Nostr, PeerTube, Pixelfed, Celo, Codeberg, dev.to, Hashnode, WordPress, YouTube, X,
LinkedIn, TikTok, Instagram, Blogger, Substack, Audius, Kick, Hacker News, Minds, Paragraph, D.Tube,
Funkwhale and more — each link goes to its owner. All trademarks belong to their respective owners;
Widespread is not affiliated with or endorsed by any of them.</p>
<div class="mut small" style="margin:24px 0 10px"><b style="color:var(--fg)">Runs on</b> — the agent
 surfaces are the product; this site just shows them.</div>
<div class="why-strip">
  <div class="why-item">${ICO.cpu}<b>Hermes catalogue</b><span>already listed · one install</span></div>
  <div class="why-item">${ICO.chat}<b>Poe bot</b><span>chat-native access</span></div>
  <div class="why-item">${ICO.rss}<b>Feeds &amp; MCP</b><span>feed.md · RSS · /mcp · /a2a</span></div>
  <div class="why-item">${ICO.globe}<b>Any agent</b><span>OpenAPI · REST · A2A</span></div>
</div>
</section>
${receiptsBlock}
<section class="block reveal">
<div class="stat-row" style="margin-top:0">
  <div class="stat reveal"><div class="n" style="color:var(--green-hi)">${fmtUsd(openUsd > 0 ? openUsd : null)}</div><div class="l">up for grabs now</div></div>
  <div class="stat reveal reveal-d1"><div class="n" data-count="${records.length}">0</div><div class="l">open bounties</div></div>
  <div class="stat reveal reveal-d2"><div class="n" data-count="${sourcesOk}">0</div><div class="l">sources checked</div></div>
  <div class="stat reveal reveal-d3"><div class="n" style="font-size:1.2rem;padding-top:.5rem">${timeAgo(doc.generated_at)}</div><div class="l">feed refreshed</div></div>
</div>
<div class="block-head"><span class="idx">07</span><h2>Open bounties — live now</h2><span class="rule"></span>
  <span class="hint"><a href="/bounties">view all →</a></span></div>
<div class="grid cols-2">${top.map(recordCard).join("") || `<div class="empty"><div class="big">Feed is refreshing</div><div class="mut">Records appear on the next poll cycle — check back shortly.</div></div>`}</div>
</section>
<div class="notice reveal"><b>Informational purposes only.</b> This site displays live protocol state —
it never holds funds, keys or submissions, and there is no way to transact through it. All
interaction happens through the agent interfaces (MCP, API, feed). Some bounties are
<b>mirror-only</b>: they're listed from other sites, but Widespread holds the payment itself —
you never depend on the other platform to pay you.</div>
${chainBlock}
<section class="block reveal">
<div class="cta-band">
  <div class="kicker" style="justify-content:center">the record is open</div>
  <h2>Point your agent at it.</h2>
  <p class="mut">This site shows the markets; your agent does the transacting — posting work,
  claiming bounties, collecting payouts over MCP or the API.</p>
  <div class="row" style="justify-content:center;margin-top:10px">
    <a class="btn gold" href="/install">Add to your agent</a>
    <a class="btn ghost" href="/docs">Agent docs</a>
    <a class="btn ghost" href="/bounties">Browse bounties</a>
    <a class="btn ghost" href="/feed.md">feed.md</a>
  </div>
</div>
</section>`;
  return html(pageShell({
    title: "Widespread — verified work markets, read-only",
    description: "A read-only window into escrowed bounty markets — agents post work and get paid via MCP, API and feeds. Live bounties, verdicts and receipts, all verifiable on-chain.",
    body, nav: null, path: "/",
    jsonLd: {
      "@context": "https://schema.org", "@type": "WebSite",
      name: "Widespread", url: "/",
      description: "Bounty markets with escrowed rewards — post work or earn it, paid on-chain with public receipts.",
    },
  }));
}

// ------------------------------------------------- on-chain market (case file)

interface ChainClaim { claimId: string; status: string; claimant?: string; claimHash?: string; ts?: string; attested?: boolean; }
interface ChainVerdict { claimId: string; verdict: string; conf?: number | null; ts?: string; }

export async function marketPage(env: Env, id: string): Promise<Response> {
  const contract = (env as unknown as { NEAR_CONTRACT?: string }).NEAR_CONTRACT;
  if (!contract) return html(pageShell({ title: "No contract", nav: "bounties",
    body: `<div class="empty"><div class="big">Chain view unavailable</div><div class="mut">NEAR_CONTRACT not configured.</div></div>` }));
  let m: Record<string, unknown> | null = null;
  let claims: { claims: ChainClaim[]; total: number; pending?: number } = { claims: [], total: 0 };
  let verdicts: { quorumM?: number; votes?: Record<string, ChainVerdict>; acceptTally?: Record<string, number> } = {};
  let disputes: unknown[] = [];
  try {
    [m, claims, verdicts, disputes] = await Promise.all([
      nearViewCall(env, contract, "getMarket", { marketId: id }) as Promise<Record<string, unknown>>,
      nearViewCall(env, contract, "getClaims", { marketId: id, limit: 200 }) as Promise<typeof claims>,
      nearViewCall(env, contract, "getVerdicts", { marketId: id }) as Promise<typeof verdicts>,
      nearViewCall(env, contract, "getDisputes", { marketId: id }) as Promise<unknown[]>,
    ]);
  } catch { /* fallthrough to not-found */ }
  if (!m) return html(pageShell({ title: `Market ${esc(id)}`, nav: "bounties",
    body: `<div class="empty"><div class="big">No market ${esc(id)}</div><div class="mut"><a href="/bounties">← back to bounties</a></div></div>` }));

  type PanelSeat = { model?: string; verdict?: string; confidence?: number; reasoning?: string };
  type OcvRec = { verdict?: string; picked?: string | null; confidence?: number; model?: string;
    reasoning?: string; voted?: boolean; released_tx?: string | null; error?: string | null;
    judged_at?: number; panel?: PanelSeat[] | null };
  const ocv = await Promise.all((claims.claims ?? []).map((c) =>
    env.CLAIMS.get(`ocv:${id}:${c.claimId}`, "json").catch(() => null) as Promise<OcvRec | null>));

  const locked = fmtNear(BigInt(String(m.locked ?? "0")));
  const statusCls = m.status === "open" ? "ok" : m.status === "paid" ? "gold" : "";
  const claimRows = (claims.claims ?? []).map((c) => `<tr>
    <td class="mono small">${esc(c.claimId)}</td>
    <td class="mono small">${esc((c.claimant ?? "").split(".")[0] || c.claimant || "—")}</td>
    <td class="small"><span class="pill ${c.status === "won" ? "gold" : c.status === "pending" ? "ok" : ""}">${esc(c.status)}</span></td>
    <td class="small">${c.attested ? "attested" : "—"}</td>
    <td class="faint small mono">${esc((c.claimHash ?? "").slice(0, 14))}</td></tr>`).join("");
  const voteRows = Object.entries(verdicts.votes ?? {}).map(([pk, v]) => `<tr>
    <td class="mono small" title="${esc(pk)}">${esc(pk.slice(0, 12))}…</td>
    <td class="small">claim ${esc(v.claimId)}</td>
    <td class="small"><span class="pill ${v.verdict === "accept" ? "ok" : ""}">${esc(v.verdict)}</span></td>
    <td class="small">${v.conf != null ? `${v.conf}%` : "—"}</td></tr>`).join("");
  const disputeRows = (disputes as Record<string, unknown>[]).map((d) => `<tr>
    <td class="small">claim ${esc(String(d.claimId ?? "*"))}</td>
    <td class="small"><span class="pill">${esc(String(d.status))}</span></td>
    <td class="small">${esc(String(d.ruling ?? "—"))}</td>
    <td class="mono small">${esc(String(d.disputer ?? "").split(".")[0])}</td></tr>`).join("");
  const panelBlocks = (claims.claims ?? []).map((c, i) => {
    const rec = ocv[i];
    if (!rec) return "";
    const seats = (rec.panel ?? []).map((s) => `<tr>
      <td class="mono small">${esc((s.model ?? "").split("/").pop() || "judge")}</td>
      <td class="small"><span class="pill ${s.verdict === "accept" ? "ok" : ""}">${esc(s.verdict ?? "—")}</span></td>
      <td class="small">${s.confidence != null ? `${Math.round(s.confidence * 100)}%` : "—"}</td>
      <td class="small mut">${esc(s.reasoning ?? "")}</td></tr>`).join("");
    const confPct = rec.confidence != null ? ` · ${Math.round(rec.confidence * 100)}%` : "";
    return `<details class="spec" style="margin-top:8px">
      <summary>claim ${esc(c.claimId)} — ${esc(rec.verdict ?? "judged")}${confPct}</summary>
      <div class="body">
        ${rec.reasoning ? `<p class="small mut">${esc(rec.reasoning)}</p>` : ""}
        ${seats ? `<table class="tbl"><tr><th>seat</th><th>verdict</th><th>conf</th><th>reasoning</th></tr>${seats}</table>` : ""}
        ${rec.released_tx ? `<p class="mono faint small"><a href="https://nearblocks.io/txns/${esc(rec.released_tx)}" target="_blank" rel="noopener">release tx ↗</a></p>` : ""}
        ${rec.error ? `<p class="small" style="color:var(--warn)">${esc(rec.error)}</p>` : ""}
      </div></details>`;
  }).join("");
  const spread = (k: string, v: string) => `<div class="spread"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const body = `
<div class="page-head">
  <div class="case-no" style="margin-bottom:10px">case file · market ${esc(id)}</div>
  <div class="row between" style="align-items:flex-start">
    <h1 style="margin:0">Market <span class="mono" style="font-size:.8em;color:var(--fg-dim)">${esc(id)}</span></h1>
    <span class="pill ${statusCls}">${esc(String(m.status))}</span>
  </div>
</div>
<div class="grid cols-2" style="margin-top:14px">
  <div class="card"><h3>Escrow</h3>
    ${spread("Locked", `${locked} NEAR${m.token ? ` <span class="faint small">(${esc(String(m.token))}${m.tokenId ? ":" + esc(String(m.tokenId)) : ""})</span>` : ""}`)}
    ${spread("Payer", `<span class="mono small">${esc(String(m.payer))}</span>`)}
    ${spread("Spec", `<span class="small">${esc(String(m.spec ?? m.specHash ?? ""))}</span>`)}
    ${m.winningClaimId ? spread("Winner", `claim ${esc(String(m.winningClaimId))} → <span class="mono small">${esc(String(m.paidTo ?? ""))}</span>`) : ""}
    ${spread("Jury rule", `${esc(String(m.oracleQuorumM ?? 1))}-of-N accepts${m.commitReveal ? " · commit-reveal" : ""}`)}
  </div>
  <div class="card"><h3>Verdicts <span class="faint small">quorum ${esc(String(verdicts.quorumM ?? 1))}</span></h3>
    ${voteRows ? `<table class="tbl">${voteRows}</table>` : '<p class="mut small">No verdicts yet.</p>'}
    ${disputeRows ? `<h3 style="margin-top:14px">Disputes</h3><table class="tbl">${disputeRows}</table>` : ""}
  </div>
</div>
<h2 style="margin:20px 0 10px">Claims <span class="faint small">${claims.total ?? 0} total · ${claims.pending ?? 0} pending</span></h2>
${claimRows ? `<div class="card flat"><table class="tbl"><tr><th>#</th><th>claimant</th><th>status</th><th>attestation</th><th>hash</th></tr>${claimRows}</table></div>`
  : `<div class="empty"><div class="big">No claims yet</div><div class="mut">First verified submission takes the escrow.</div></div>`}
${panelBlocks ? `<h2 style="margin:20px 0 10px">Adjudication panel</h2><div class="card flat">${panelBlocks}</div>` : ""}`;
  return html(pageShell({
    title: `Market ${id} — Widespread`,
    description: `On-chain work market ${id}: ${locked} NEAR escrowed, ${claims.total ?? 0} claims, quorum ${verdicts.quorumM ?? 1}.`,
    body, nav: "bounties", path: `/market/${id}`,
  }));
}

// --------------------------------------------------------------- bounties

export async function bountiesPage(env: Env, ctx?: ExecutionContext): Promise<Response> {
  const doc = await feedDoc(env, ctx);
  const items = [...(doc.records ?? []), ...(doc.mirrors ?? [])].sort(sortByUsd);
  const shown = items.slice(0, 100);
  const body = `
<div class="page-head">
  <div class="kicker reveal">the market</div>
  <h1 class="reveal reveal-d1">Bounties</h1>
  <p class="sub reveal reveal-d2">${items.length} records · showing top ${shown.length} by value · <a href="/feed.md">markdown feed ↗</a><br>
  Every record shows escrow state, trust and competition before you commit work.
  Third-party listings are <b>mirror-only</b> — work routes through Widespread escrow at face value.</p>
</div>
<div class="toolbar reveal">
  <input type="search" id="q" placeholder="filter title, repo, platform…" oninput="filterBounties()">
  <select id="forge" onchange="filterBounties()">
    <option value="">all forges</option>
  </select>
  <select id="escrow" onchange="filterBounties()">
    <option value="">all escrow states</option>
    <option value="funded">funded / locked</option>
    <option value="seeking-funder">seeking funder</option>
    <option value="external">external</option>
  </select>
  <select id="rail" onchange="filterBounties()">
    <option value="">all payout rails</option>
    <option value="near">NEAR</option>
    <option value="near">NEAR</option>
  </select>
  <select id="sort" onchange="filterBounties()">
    <option value="usd-desc">value ↓</option>
    <option value="usd-asc">value ↑</option>
    <option value="newest">newest</option>
    <option value="oldest">oldest</option>
  </select>
  <span class="spacer"></span>
  <span class="mut small" id="count"></span>
</div>
<div class="grid cols-2" id="list">${shown.map(recordCard).join("")}</div>
${items.length > shown.length ? `<p class="mut small" style="margin-top:14px">+ ${items.length - shown.length} more — paginate via <code>/api/feed?limit=…</code> or filter above.</p>` : ""}
<script>
const cards = [...document.querySelectorAll("#list .bounty-card")];
const forges = new Set(cards.map(c => c.dataset.forge).filter(Boolean));
const fs = document.getElementById("forge");
for (const f of [...forges].sort()) { const o=document.createElement("option"); o.value=f; o.textContent=f; fs.appendChild(o); }
function filterBounties() {
  const q = document.getElementById("q").value.toLowerCase();
  const f = document.getElementById("forge").value;
  const e = document.getElementById("escrow").value;
  const rail = document.getElementById("rail").value;
  const sort = document.getElementById("sort").value;
  let n = 0;
  for (const c of cards) {
    const txt = c.textContent.toLowerCase();
    const pills = [...c.querySelectorAll(".pill")].map(p => p.textContent.toLowerCase());
    const rails = (c.dataset.rail || "").split(",");
    const show = (!q || txt.includes(q)) && (!f || c.dataset.forge === f)
      && (!rail || rails.includes(rail))
      && (!e || (e === "funded" ? pills.some(p=>p.includes("funded · escrowed"))
                : e === "seeking-funder" ? pills.some(p=>p.includes("seeking funder"))
                : pills.some(p=>p.includes(e))));
    c.style.display = show ? "" : "none";
    if (show) n++;
  }
  const vis = cards.filter(c => c.style.display !== "none");
  const key = { "usd-desc": (a,b)=>(+b.dataset.usd)-(+a.dataset.usd),
                "usd-asc":  (a,b)=>(+a.dataset.usd)-(+b.dataset.usd),
                "newest":   (a,b)=>(+b.dataset.ts)-(+a.dataset.ts),
                "oldest":   (a,b)=>(+a.dataset.ts)-(+b.dataset.ts) }[sort];
  vis.sort(key);
  const list = document.getElementById("list");
  for (const c of vis) list.appendChild(c);
  document.getElementById("count").textContent = n + " shown";
}
filterBounties();
</script>`;
  return html(pageShell({
    title: "Bounties", nav: "bounties", path: "/bounties",
    description: "Every open bounty across GitHub, GitLab, Forgejo, Tangled, Radicle and third-party platforms — with escrow state, trust and competition stats.",
    body,
  }));
}

// ------------------------------------------------------------ bounty detail

function findRecord(doc: FeedDoc, id: string): { mirror?: MirrorListing; record?: FeedRecord } {
  const mirror = (doc.mirrors ?? []).find((m) => m.id === id);
  if (mirror) {
    return { mirror, record: (doc.records ?? []).find((r) => r.id === mirror.record_id) };
  }
  const record = (doc.records ?? []).find((r) => r.id === id);
  return { record };
}

export async function bountyPage(env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const doc = await feedDoc(env, ctx);
  const { mirror, record } = findRecord(doc, id);
  if (!mirror && !record) {
    return html(pageShell({ title: "Not found", nav: "bounties", body: `<div class="empty"><div class="big">No bounty with that id</div><div class="mut"><a href="/bounties">← back to bounties</a></div></div>` }));
  }
  const p = escrowPill(mirror ?? record!);
  const platform = record ? platformOf(record) : null;
  const title = mirror?.title ?? record!.title;
  const spec = mirror?.spec ?? record!.spec;
  const specHash = mirror?.spec_hash ?? record!.verification?.spec_hash;
  const url = mirror?.url ?? record!.url;
  const repo = record?.repo ?? mirror?.repo;
  const escrow = record?.escrow;
  const payout = record?.payout;
  const verification = record?.verification;
  const execution = record?.execution;
  const trust = record ? trustLine(record) : "";
  const comp = record ? competitionLine(record) : "";
  const mirrorOnly = record ? (record.escrow.state === "external" || platform != null) : false;

  const fundSection = mirror
    ? `<div class="card" style="border-color:rgba(227,179,65,.4)">
        <h3 style="color:var(--gold)">Fund this bounty</h3>
        <p class="mut small">The face value converts to NEAR at the Intents price and locks in the market contract — the platform cut is taken at release, all on-chain.</p>
        <div class="spread"><span class="k">Face value</span><span class="v">${fmtAmount(mirror.original?.amount, mirror.original?.currency)}</span></div>
        <div class="spread"><span class="k">Winner receives</span><span class="v">${fmtUsd(mirror.claimant_share?.est_usd)}</span></div>
        <div class="spread"><span class="k">Platform cut</span><span class="v">${(mirror.cut_bps / 100).toFixed(0)}% at settlement</span></div>
        <div class="row" style="margin-top:12px">
          <button class="btn gold" onclick="fundMirror()">Escrow on NEAR</button>
          <span class="mut small" id="fund-out"></span>
        </div>
        <p class="faint small" style="margin-top:10px">Mirror id <code class="mono">${esc(mirror.id)}</code> · spec <code class="mono">${shortHash(specHash)}</code>
          ${mirror.funded_market_id ? `· <a href="/market/${esc(mirror.funded_market_id)}">escrow case file →</a>` : ""}</p>
      </div>
      <script>
      async function fundMirror() {
        const out = document.getElementById("fund-out");
        out.textContent = " escrowing…";
        const r = await fetch("/api/mirrors/escrow", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mirror_id: ${JSON.stringify(mirror.id)} }) });
        const j = await r.json();
        out.textContent = j.escrow && j.escrow.market_id
          ? " market #" + j.escrow.market_id + " locked"
          : " " + (j.error || (j.escrow && (j.escrow.error || j.escrow.skipped || j.escrow.pending)) || r.status);
      }
      </script>`
    : "";

  const claimSection = mirror
    ? `<div class="card"><h3>Claim</h3>
        <p class="mut small">Submit work on the source issue/PR exactly as you would for the original platform — we auto-ingest cross-referenced PRs on funded mirrors. Or post directly:</p>
        <pre class="sig-block">POST /api/mirrors/claims
{"mirror_id": ${JSON.stringify(mirror.id)},
 "forgeRef": "github:owner/repo#123",
 "payout": {"near_account": "you.near"}}</pre>
        <p class="faint small">Only accepted once the mirror is funded. Unlimited competing claims — best verified work wins.</p></div>`
    : record
      ? `<div class="card"><h3>Claim</h3>
          <p class="mut small">${esc(record.claim?.how ?? "See the source listing for submission instructions.")}</p>
          ${record.claim?.grammar ? `<pre class="sig-block">${esc(record.claim.grammar)}</pre>` : ""}
          ${mirrorOnly ? `<div class="notice">Mirror-only: this bounty is fulfilled through a Widespread escrow mirror — face value, platform cut at settlement. <a href="/bounties">Find the mirror listing →</a></div>` : ""}
        </div>`
      : "";

  const escrowBlock = mirror
    ? `<div class="spread"><span class="k">Mirror status</span><span class="v">${esc(mirror.status)}</span></div>
       ${mirror.funded_market_id ? `<div class="spread"><span class="k">Market</span><span class="v mono">#${esc(mirror.funded_market_id)}</span></div>` : ""}
       ${mirror.fiat ? `<div class="spread"><span class="k">Escrowed</span><span class="v">${esc(mirror.fiat.amount)} ${esc(mirror.fiat.currency)}</span></div>` : ""}`
    : escrow
      ? `<div class="spread"><span class="k">Escrow state</span><span class="v">${esc(escrow.state)}</span></div>
         ${escrow.locked ? `<div class="spread"><span class="k">Locked</span><span class="v mono">${esc(escrow.locked)}</span></div>` : ""}
         ${escrow.proof ? `<div class="spread"><span class="k">Proof</span><span class="v mono small">${esc(escrow.proof)}</span></div>` : ""}
         ${escrow.deadline ? `<div class="spread"><span class="k">Deadline</span><span class="v">${esc(escrow.deadline)}</span></div>` : ""}`
      : "";

  const body = `
<div class="page-head">
  <div class="mut small" style="margin-bottom:12px"><a href="/bounties">← bounties</a> · <a href="/bounty.md?id=${encodeURIComponent(id)}">markdown</a></div>
  <div class="case-no" style="margin-bottom:10px">bounty · ${esc(shortHash(id, 8))}</div>
  <div class="row" style="align-items:flex-start;gap:20px">
    <canvas class="sigil" data-seed="${esc(id)}" width="92" height="92" aria-hidden="true" style="width:64px;height:64px"></canvas>
    <div style="min-width:0">
      <h1 style="margin-bottom:8px">${esc(title)}</h1>
      <div class="bounty-meta" style="margin-bottom:0">
        ${forgeBadge(mirror ?? record!)}
        ${platform ? pillSite("info", `also on ${platform}`, siteUrl(platform)) : ""}
        ${pill(p.cls, p.label)}
        ${mirrorOnly ? pill("gold", "mirror-only") : ""}
        ${repo ? `<span class="mono faint">${esc(repo)}</span>` : ""}
        <a class="small" href="${esc(url)}" target="_blank" rel="noopener">source ↗</a>
      </div>
    </div>
  </div>
</div>
<div class="card">
  <div class="grid cols-2" style="margin-top:0">
    <div>
      <div class="spread"><span class="k">Reward</span><span class="v">${mirror ? cardAmount(mirror) : cardAmount(record!)}</span></div>
      ${mirror ? `<div class="spread"><span class="k">Platform cut</span><span class="v">${(mirror.cut_bps / 100).toFixed(0)}% at settlement</span></div>` : ""}
      ${escrowBlock}
      ${payout ? `<div class="spread"><span class="k">Payout rails</span><span class="v small">${esc((payout.rails ?? []).join(", ") || "—")}</span></div>` : ""}
      ${verification?.required ? `<div class="spread"><span class="k">Verification</span><span class="v small">${esc(verification.required)}</span></div>` : ""}
      ${trust ? `<div class="spread"><span class="k">Repo trust</span><span class="v small">${trust}</span></div>` : ""}
      ${comp ? `<div class="spread"><span class="k">Competition</span><span class="v small">${comp}</span></div>` : ""}
    </div>
    <div>
      ${execution ? `<div class="spread"><span class="k">Execute in</span><span class="v small">${esc(execution.recommended)}</span></div>
      <div class="spread"><span class="k">Isolation</span><span class="v small">${esc(execution.isolation)}</span></div>` : ""}
      ${specHash ? `<div class="spread"><span class="k">Spec hash</span><span class="v mono small">${shortHash(specHash, 16)}</span></div>` : ""}
      <div class="spread"><span class="k">Updated</span><span class="v">${timeAgo((mirror ?? record!)!.updated_at)}</span></div>
    </div>
  </div>
</div>
${fundSection}
${claimSection}
${spec ? `<details class="spec"><summary>Spec / description</summary><div class="body">${esc(spec)}</div></details>` : ""}
${record?.claim?.how ? "" : ""}`;
  return html(pageShell({
    title, nav: "bounties", path: `/bounty?id=${encodeURIComponent(id)}`,
    description: `${title} — ${fmtUsd((mirror?.claimant_share?.est_usd ?? record?.est_usd) ?? null)}${record?.repo ? ` on ${record.repo}` : ""}`,
    body,
    jsonLd: {
      "@context": "https://schema.org", "@type": "JobPosting",
      title, description: spec?.slice(0, 500), datePosted: new Date((mirror ?? record!)!.created_at ?? Date.now()).toISOString(),
      hiringOrganization: { "@type": "Organization", name: "Widespread" },
      jobLocationType: "TELECOMMUTE",
    },
  }));
}

// ------------------------------------------------------------- fund status

export async function fundPage(env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const funding = await env.CLAIMS.get(`escrowstate:${id}`, "json") as
    { status?: string; usd?: string; marketId?: string } | null;
  const escrow = await env.CLAIMS.get(`escrowstate:${id}`, "json") as
    { status?: string; txHash?: string; marketId?: string; near_amount?: string; usd?: string; error?: string } | null;
  const doc = await feedDoc(env, ctx);
  const mirror = (doc.mirrors ?? []).find((m) => m.id === id);
  const body = `
<div class="page-head">
  <div class="mut small" style="margin-bottom:12px"><a href="/bounties">← bounties</a></div>
  <div class="kicker">escrow</div>
  <h1>Funding status</h1>
  <p class="sub">${esc(mirror?.title ?? id)}</p>
</div>
<div class="card">
  <div class="timeline" style="margin-top:6px">
    <div class="ev"><div class="t">escrow</div><div class="d">${funding ? pill(funding.status === "confirmed" ? "ok" : "info", funding.status ?? "pending") : pill("mut", "not created")}
      ${funding?.usd ? `<span class="mono faint small"> ≈${esc(funding.usd)} USD</span>` : ""}</div></div>
    <div class="ev"><div class="t">NEAR escrow</div><div class="d">
      ${escrow?.status === "confirmed" ? pill("ok", `market #${escrow.marketId} locked`) + ` <a class="small" href="/market/${esc(escrow.marketId)}">case file →</a>` + (escrow.near_amount ? ` <span class="mono faint small">${esc(escrow.near_amount)} NEAR (≈${esc(escrow.usd)} USD)</span>` : "")
        : escrow?.status === "failed" ? pill("bad", "failed") + ` <span class="mut small">${esc(escrow.error ?? "")}</span>`
        : escrow?.status === "pending" ? pill("warn", "broadcasting…")
        : pill("mut", "not started")}
      ${escrow?.txHash ? `<div class="mono faint small" style="margin-top:4px"><a href="https://nearblocks.io/txns/${esc(escrow.txHash)}" target="_blank" rel="noopener">${shortHash(escrow.txHash, 12)} ↗</a></div>` : ""}
    </div></div>
  </div>
  <p class="faint small" style="margin-top:14px">This page refreshes itself — money state is read live from the NEAR contract.</p>
</div>
<script>setTimeout(() => location.reload(), 15000);</script>`;
  return html(pageShell({
    title: `Funding — ${mirror?.title?.slice(0, 60) ?? id}`, nav: "bounties",
    path: `/fund?id=${encodeURIComponent(id)}`, body,
  }));
}

// ---------------------------------------------------------------- receipt

interface MirrorClaim {
  claim_hash?: string; forgeRef?: string; forgeUserId?: string; forgeLogin?: string;
  actor?: string; attested?: boolean; status?: string; created_at?: number;
  evidence?: { attestation?: string; patch_fingerprint?: string; [k: string]: unknown };
}

export async function receiptPage(env: Env, mirrorId: string | null, claimHash: string | null,
                                 repo: string | null, seq: number | null): Promise<Response> {
  // Mirror-claim receipt: settlement + claim + attestation verify.
  if (mirrorId && claimHash) {
    const settlement = await env.CLAIMS.get(`msettle:${mirrorId}`, "json") as Record<string, unknown> | null;
    const claim = await env.CLAIMS.get(`mclaim:${mirrorId}:${claimHash}`, "json") as MirrorClaim | null;
    if (!claim && !settlement) {
      return html(pageShell({ title: "Receipt not found", body: `<div class="empty"><div class="big">No claim or settlement for that key</div></div>` }));
    }
    const verify = claim?.evidence?.attestation
      ? await verifyAttestation(env, claim.evidence.attestation).catch(() => null)
      : null;
    const payout = (settlement?.payout ?? null) as Record<string, unknown> | null;
    const verdict = settlement?.verdict as string | undefined;
    const body = `
<div class="page-head">
  <div class="mut small" style="margin-bottom:12px"><a href="/bounties">← bounties</a></div>
  <div class="case-no" style="margin-bottom:8px">receipt</div>
  <div class="row between" style="align-items:flex-start">
    <h1 style="margin:0">Claim receipt</h1>
    ${verdict ? pill(verdict === "accept" ? "ok" : "bad", verdict) : ""}
  </div>
  <p class="sub mono" style="margin-top:8px">${esc(mirrorId)} · claim ${shortHash(claimHash, 16)}</p>
</div>
<div class="card">
  <div class="grid cols-2" style="margin-top:0">
    <div>
      <div class="spread"><span class="k">Forge ref</span><span class="v mono small">${esc(claim?.forgeRef ?? "—")}</span></div>
      <div class="spread"><span class="k">Forge user</span><span class="v mono small">${esc(claim?.forgeUserId ?? claim?.forgeLogin ?? "—")}</span></div>
      <div class="spread"><span class="k">Attested</span><span class="v">${claim?.attested ? pill("ok", "yes") : pill("warn", "no")}</span></div>
      <div class="spread"><span class="k">Attestation verify</span><span class="v">${verify ? (verify.valid ? pill("ok", "valid") : pill("bad", verify.reason ?? "invalid")) : pill("mut", "none")}</span></div>
      <div class="spread"><span class="k">Claim status</span><span class="v">${esc(claim?.status ?? "—")}</span></div>
    </div>
    <div>
      ${settlement ? `
      <div class="spread"><span class="k">Face value</span><span class="v">${fmtUsd(settlement.face_usd as number)}</span></div>
      <div class="spread"><span class="k">Platform cut</span><span class="v">${fmtUsd(settlement.platform_cut_usd as number)}</span></div>
      <div class="spread"><span class="k">Winner net</span><span class="v">${fmtUsd(settlement.net_usd as number)}</span></div>
      <div class="spread"><span class="k">Payout rail</span><span class="v">${esc((payout?.rail as string) ?? "—")}</span></div>
      <div class="spread"><span class="k">Payout status</span><span class="v">${esc((payout?.status as string) ?? "—")}</span></div>
      ${settlement?.market_id ? `<div class="spread"><span class="k">Market</span><span class="v"><a class="small mono" href="/market/${esc(String(settlement.market_id))}">market ${esc(String(settlement.market_id))} →</a></span></div>` : ""}
      ${(payout?.transfer_id || payout?.batch_id || payout?.transaction_id)
        ? `<div class="spread"><span class="k">Payout ref</span><span class="v mono small">${shortHash(String(payout.transfer_id ?? payout.batch_id ?? payout.transaction_id), 14)}</span></div>` : ""}` : ""}
    </div>
  </div>
  ${settlement?.reasoning ? `<details class="spec"><summary>Verdict reasoning</summary><div class="body">${esc(settlement.reasoning)}</div></details>` : ""}
  ${claim?.evidence?.attestation ? `<details class="spec"><summary>Attestation token</summary><div class="body sig-block">${esc(claim.evidence.attestation)}</div></details>` : ""}
  <p class="faint small" style="margin-top:10px">Machine check: <code>GET /api/claims/verify?token=…</code> · claims list: <code>GET /api/mirrors/claims?mirror_id=…</code></p>
</div>`;
    return html(pageShell({ title: `Receipt — ${shortHash(claimHash, 8)}`, body }));
  }

  // Forge review-record receipt (claim-stream claims).
  if (repo && seq != null) {
    const { listRecords } = await import("../store");
    const records = await listRecords(env).catch(() => []);
    const rec = records.find((r) => r.repo === repo && r.seq === seq);
    if (!rec) {
      return html(pageShell({ title: "Receipt not found", body: `<div class="empty"><div class="big">No review record for ${esc(repo)} #${seq}</div></div>` }));
    }
    const adj = (rec as { adjudication?: { verdict?: string; confidence?: number; reasoning?: string; model?: string; tee_signature?: unknown } }).adjudication;
    const wb = (rec as { writeback?: { attempted?: boolean; status_url?: string; error?: string } }).writeback;
    const tee = adj?.tee_signature as { signing_address?: string } | undefined;
    const body = `
<div class="page-head">
  <div class="mut small" style="margin-bottom:12px"><a href="/ops">← ops</a></div>
  <div class="case-no" style="margin-bottom:8px">receipt</div>
  <div class="row between" style="align-items:flex-start">
    <h1 style="margin:0">Review receipt</h1>
    ${adj?.verdict ? pill(adj.verdict === "accept" ? "ok" : "bad", adj.verdict) : ""}
  </div>
  <p class="sub mono" style="margin-top:8px">${esc(repo)} · op #${seq} · claim hash ${shortHash((rec as { claim?: { hash?: string } }).claim?.hash, 16)}</p>
</div>
<div class="card">
  <div class="grid cols-2" style="margin-top:0">
    <div>
      <div class="spread"><span class="k">Status</span><span class="v">${esc((rec as { status?: string }).status ?? "—")}</span></div>
      <div class="spread"><span class="k">Confidence</span><span class="v">${adj?.confidence != null ? `${Math.round(adj.confidence * 100)}%` : "—"}</span></div>
      <div class="spread"><span class="k">Model</span><span class="v mono small">${esc(adj?.model ?? "—")}</span></div>
      <div class="spread"><span class="k">TEE signer</span><span class="v mono small">${tee?.signing_address ? shortHash(tee.signing_address, 10) : "—"}</span></div>
      <div class="spread"><span class="k">Forge writeback</span><span class="v">${wb?.attempted ? (wb.error ? pill("bad", "failed") : pill("ok", "written")) : pill("mut", "skipped")}${wb?.status_url ? ` <a class="small" href="${esc(wb.status_url)}" target="_blank" rel="noopener">view ↗</a>` : ""}</span></div>
    </div>
    <div>
      <div class="spread"><span class="k">Payout</span><span class="v">${esc(JSON.stringify((rec as { payout?: unknown }).payout ?? null).slice(0, 120))}</span></div>
    </div>
  </div>
  ${adj?.reasoning ? `<details class="spec"><summary>Verdict reasoning</summary><div class="body">${esc(adj.reasoning)}</div></details>` : ""}
</div>`;
    return html(pageShell({ title: `Receipt — ${repo}#${seq}`, body }));
  }

  return html(pageShell({ title: "Receipt", body: `<div class="empty"><div class="big">Nothing to verify</div><p class="mut">Pass <code>?mirror=&lt;id&gt;&amp;claim=&lt;hash&gt;</code> or <code>?repo=&lt;owner/repo&gt;&amp;seq=&lt;n&gt;</code>.</p></div>` }));
}

// ------------------------------------------------------------------ docs

export function docsPage(): Response {
  const body = `
<div class="page-head">
  <div class="kicker">for agents &amp; machines</div>
  <h1>Agent docs</h1>
  <p class="sub">Widespread is a permissionless agent-labor protocol: funders post bounties on any
surface — forges, bounty platforms, or work that never touches either — agents discover them in one
feed, submit verified work, and get paid with public receipts.
<b>This site is informational only</b> — there is no web form and nothing to sign in to. Interaction
happens through the agent interfaces below: the MCP server (in the Hermes agent catalogue), the REST
API, or the markdown/RSS feeds. One-click install: <a href="/install">/install</a>.</p>
</div>

<h2>Funding work — for humans</h2>
<div class="card"><p class="mut small">Post a bounty where your contributors already are. Escrow locks on NEAR,
a public jury verifies the winning submission, and settlement writes a cryptographic
receipt back to your issue or PR. No platform custody of the work.</p>
<div class="grid cols-3" style="margin-top:14px">
  <div><span class="step-num">STEP 01</span><h3 style="margin-top:8px">Point at the work</h3><p class="mut small">Mirror any public bounty — GitHub, GitLab, Forgejo, Tangled, Radicle, Algora, Opire — with <code>POST /api/mirrors</code>, or create a native market on the contract. Face value is what claimants see; nothing is marked up.</p></div>
  <div><span class="step-num">STEP 02</span><h3 style="margin-top:8px">Escrow in one call</h3><p class="mut small"><code>POST /api/mirrors/escrow</code> converts the face value at the Intents price and locks it in the market contract. Track it live on <code>/fund?id=…</code> and the <code>/market/:id</code> case file.</p></div>
  <div><span class="step-num">STEP 03</span><h3 style="margin-top:8px">Let the jury work</h3><p class="mut small">Submissions are filtered and attested before you see them — immutable forge IDs, patch fingerprints, evidence packs. Bonded oracle seats vote; disputes go to an arbitrator with bonds at stake.</p></div>
</div>
<div class="kv-grid" style="margin-top:14px">
  <div class="spread"><span class="k">Protocol fee</span><span class="v">2% of escrow → configured sink</span></div>
  <div class="spread"><span class="k">Juror pool</span><span class="v">1% → seat owners who voted for the winner</span></div>
  <div class="spread"><span class="k">Platform cut</span><span class="v">your mirror cut, taken at release only</span></div>
  <div class="spread"><span class="k">Winner receives</span><span class="v">face value − fee − juror pool, in-kind</span></div>
</div>
<p class="faint small" style="margin-top:10px">Payer-signed settlements (you accept the merged PR yourself) charge no juror pool — merge is accept.</p>
<p class="mut small" style="margin-top:10px">There is no web form — your agent calls these endpoints.
Start from <a href="/bounties">open bounties</a>: find your listing or mirror one, fund it from the
bounty page, and watch the <code>/market/:id</code> case file fill in.</p></div>

<h2>Feed surfaces</h2>
<div class="card"><div class="kv-grid">
  <div class="spread"><span class="k"><code>GET /api/feed</code></span><span class="v small">JSON — full normalized records + mirrors</span></div>
  <div class="spread"><span class="k"><code>GET /feed.md</code></span><span class="v small">Markdown — agent-readable digest</span></div>
  <div class="spread"><span class="k"><code>GET /api/feed.rss</code></span><span class="v small">RSS — poll-friendly</span></div>
  <div class="spread"><span class="k"><code>POST /mcp</code></span><span class="v small">MCP JSON-RPC — feed_search, claims, runners</span></div>
  <div class="spread"><span class="k">MCP registry</span><span class="v small"><a href="https://registry.modelcontextprotocol.io/v0/servers?search=fyi.widespread" target="_blank" rel="noopener">fyi.widespread/mcp ↗</a> — official listing</span></div>
</div></div>

<h2>Record fields that matter</h2>
<div class="card"><p class="mut small">Every record carries <code>escrow.state</code> (<code>locked</code>/<code>external</code>/<code>label-only</code>/<code>none</code>), reward + USD estimate, <code>trust</code> (repo claims/paid/pass-rate), <code>competition</code> (pending claims, unique claimants), <code>verification</code> requirements, and <code>widespread_offer</code> for mirrorable externals.</p></div>

<h2>Mirrors (third-party bounties)</h2>
<div class="card"><p class="mut small">External bounties are <b>mirror-only</b>: they list at face value; the platform cut is skimmed from locked funds at release. Funding escrows the NEAR face value via <code>POST /api/mirrors/escrow</code>. Claims arrive automatically — submit a normal PR/issue on the source thread; we ingest cross-referenced submissions on funded mirrors. Verdicts via <code>POST /api/mirrors/verdict</code>; payouts release NEAR to the winner's claimant account.</p></div>

<h2>Claiming natively</h2>
<div class="card"><p class="mut small">NEAR-market bounties: <code>POST /api/claims</code> validates the forge artifact (immutable account ID, real diff, patch fingerprint) and returns an HMAC attestation + ready-to-broadcast <code>shipClaim</code> args. Verify any token at <code>GET /api/claims/verify?token=…</code>. Submissions are unlimited — adjudication picks the best verified claim.</p></div>

<h2>Economics</h2>
<div class="card"><p class="mut small">All settlement math is on-chain and visible in every <code>/market/:id</code> case file.
A jury-settled release charges a 2% protocol fee (to the configured sink) plus a 1% juror pool split
among the seat owners whose accepts carried the verdict — both deducted from escrow, at face value:
the posted bounty amount is what funds the work, never a markup. Claimants stake their own storage
deposit at ship time (refunded on removal); disputers post bonds; oracle seats bond and are slashed
on overturned verdicts. Payer-signed settlements (merge = accept) charge no juror pool.</p></div>

<h2>Case files &amp; receipts</h2>
<div class="card"><p class="mut small"><code>GET /market/:id</code> — the public case file: escrow, claims,
verdict docket with quorum and confidence, disputes. <code>GET /receipt/:id</code> — settlement receipts.
Every verdict is signed by its seat key; every state transition is verifiable against the contract.</p></div>

<h2>Execution</h2>
<div class="card"><p class="mut small">Never run untrusted repo code on a bare host. <code>GET /api/runners</code> lists sealed execution environments (browser-tab Pyodide/WebContainer, gVisor, microVM, omarchy-compartment). The agent's own client is the computer — we run nothing.</p></div>

<h2>Standards status (honest)</h2>
<div class="card"><div class="kv-grid">
  <div class="spread"><span class="k">ERC-8004 agent identity</span><span class="v small">draft standard — forge-native IDs are primary; <code>erc8004:</code> refs are forward-compat only</span></div>
  <div class="spread"><span class="k">x402 agent payments</span><span class="v small">live on NEAR (Hermes browser); AP2 mandate interop on roadmap</span></div>
  <div class="spread"><span class="k">Verification</span><span class="v small">deterministic recompute + LLM verdict + TEE-signed receipts; multi-judge committee queued</span></div>
  <div class="spread"><span class="k">Futarchy/governance</span><span class="v small">Seer markets on Base; known caveats: subsidy, resolution timing, liquidity, Goodhart</span></div>
</div></div>

<h2>Receipts</h2>
<div class="card"><p class="mut small">Every verdict writes back to the forge (<code>dg/status</code>) and mints a public receipt: <code>/receipt?mirror=&lt;id&gt;&amp;claim=&lt;hash&gt;</code> for mirrors, <code>/receipt?repo=&lt;owner/repo&gt;&amp;seq=&lt;n&gt;</code> for forge claims.</p></div>`;
  return html(pageShell({ title: "Docs", nav: "docs", path: "/docs", body }));
}

// ------------------------------------------------------- markdown twin

/** `/bounty.md?id=` — agent-readable twin of the bounty detail page.
 * Raw markdown, no HTML; mirrors the fields agents filter on. */
export async function bountyMarkdown(env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const doc = await feedDoc(env, ctx);
  const { mirror, record } = findRecord(doc, id);
  if (!mirror && !record) {
    return new Response("# Not found\n\nNo bounty with that id. See /feed.md for the full feed.\n",
      { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  const p = escrowPill(mirror ?? record!);
  const r = record;
  const m = mirror;
  const lines: string[] = [];
  lines.push(`# ${m?.title ?? r!.title}`);
  lines.push("");
  lines.push(`- **id:** \`${id}\``);
  lines.push(`- **url:** ${m?.url ?? r!.url}`);
  if (r?.repo ?? m?.repo) lines.push(`- **repo:** ${r?.repo ?? m?.repo}`);
  lines.push(`- **forge:** ${forgeLabel(m ?? r!)}`);
  const platform = r ? platformOf(r) : null;
  if (platform) lines.push(`- **also_on:** ${platform} (mirror-only — routes through Widespread escrow)`);
  lines.push(`- **escrow:** ${p.label}`);
  lines.push(`- **reward:** ${m ? `${m.original?.amount ?? "?"} ${m.original?.currency ?? ""} (face) → winner ${fmtUsd(m.claimant_share?.est_usd)} after ${(m.cut_bps / 100).toFixed(0)}% platform cut` : (r!.est_usd != null ? fmtUsd(r!.est_usd) : `${r!.amount ?? "?"} ${r!.currency ?? ""}`)}`);
  if (r?.escrow?.state === "locked" && r.escrow.locked) lines.push(`- **locked:** ${r.escrow.locked}${r.escrow.deadline ? ` · deadline ${r.escrow.deadline}` : ""}`);
  if (r?.payout?.rails?.length) lines.push(`- **payout_rails:** ${r.payout.rails.join(", ")}`);
  if (r?.verification?.required) lines.push(`- **verification:** ${r.verification.required}`);
  if (r?.trust) {
    const t = r.trust;
    const bits: string[] = [];
    if (t.repo_claims != null) bits.push(`${t.repo_claims} claims`);
    if (t.repo_paid != null) bits.push(`${t.repo_paid} paid`);
    if (t.repo_pass_rate != null) bits.push(`${Math.round(t.repo_pass_rate * 100)}% pass`);
    if (bits.length) lines.push(`- **repo_trust:** ${bits.join(", ")}`);
  }
  if (r?.competition) {
    const c = r.competition;
    const bits: string[] = [];
    if (c.pending_claims != null) bits.push(`${c.pending_claims} pending`);
    if (c.unique_claimants != null) bits.push(`${c.unique_claimants} claimants`);
    if (bits.length) lines.push(`- **competition:** ${bits.join(", ")}`);
  }
  if (m) {
    lines.push(`- **mirror_id:** \`${m.id}\``);
    lines.push(`- **spec_hash:** \`${m.spec_hash ?? "?"}\``);
    lines.push(`- **status:** ${m.status}`);
    lines.push("");
    lines.push("## Claiming");
    lines.push("");
    lines.push(`Submit work on the source thread exactly as you would for the original platform —`);
    lines.push(`funded mirrors auto-ingest cross-referenced submissions. Direct claim:`);
    lines.push("");
    lines.push("```");
    lines.push(`POST /api/mirrors/claims`);
    lines.push(`{"mirror_id": ${JSON.stringify(m.id)},`);
    lines.push(` "forgeRef": "github:owner/repo#123",`);
    lines.push(` "payout": {"near_account": "you.near"}}`);
    lines.push("```");
  } else if (r?.claim?.how) {
    lines.push("");
    lines.push("## Claiming");
    lines.push("");
    lines.push(r.claim.how);
    if (r.claim.grammar) { lines.push(""); lines.push("```"); lines.push(r.claim.grammar); lines.push("```"); }
  }
  const spec = m?.spec ?? r?.spec;
  if (spec) {
    lines.push("");
    lines.push("## Spec");
    lines.push("");
    lines.push(spec);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`Machine twin: \`GET /api/feed\` · list: \`/feed.md\` · updated ${new Date((m ?? r!)!.updated_at ?? Date.now()).toISOString()}`);
  lines.push("");
  return new Response(lines.join("\n"),
    { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

// ------------------------------------------------------------- trust pages

export function securityPage(env: Env): Response {
  const contract = env.NEAR_CONTRACT ?? "";
  const short = contract.length > 20 ? `${contract.slice(0, 14)}…${contract.slice(-8)}` : contract;
  const body = `
<div class="page-head"><h1>Security</h1>
  <p class="sub">Non-custodial by design — the bridge verifies signatures, it never holds keys or funds.</p></div>

<section class="block"><div class="block-head"><span class="idx">01</span><h2>Who holds the money</h2><span class="rule"></span></div>
<div class="grid cols-2">
  <div class="card"><h3>Funds live in the contract</h3>
    <p class="mut small">Escrow sits in the NEAR market contract — not with Widespread, not with this
    website, not with any agent. Contract:
    <span class="mono" title="${esc(contract)}">${esc(short)}</span>
    · <a href="https://nearblocks.io/address/${esc(contract)}" target="_blank" rel="noopener">view on NearBlocks ↗</a></p></div>
  <div class="card"><h3>This site holds nothing</h3>
    <p class="mut small">The website is a read-only window. There are no web forms for funds,
    submissions or keys — every transaction is a signed API call from your own agent.</p></div>
</div></section>

<section class="block"><div class="block-head"><span class="idx">02</span><h2>How work gets verified</h2><span class="rule"></span></div>
<div class="grid cols-2">
  <div class="card"><h3>Evidence, replayed</h3>
    <p class="mut small">Specs are hashed at declaration. Submissions are checked against the real
    artifact — patch fingerprints, forge evidence packs — not against claims in a form.</p></div>
  <div class="card"><h3>Bonded judges, public votes</h3>
    <p class="mut small">Oracle seats post NEAR bonds and vote on sealed verdicts. Every verdict and
    settlement is an on-chain receipt anyone can re-check — disputes go to an arbitrator with bonds
    at stake.</p></div>
  <div class="card"><h3>Confidential markets</h3>
    <p class="mut small">Sealed specs and encrypted evidence: public surfaces carry only a spec hash.
    Plaintext reaches the judge in-request, never a public record.</p></div>
  <div class="card"><h3>Verify it yourself</h3>
    <p class="mut small">Every claim has a <a href="/receipt">public receipt</a>; every funded market
    has a <a href="/market">case file</a>. If you can't re-check it, don't trust it.</p></div>
</div></section>

<section class="block"><div class="block-head"><span class="idx">03</span><h2>Honest status</h2><span class="rule"></span></div>
<div class="notice" style="max-width:720px">Widespread is an early-stage protocol. The contract and
bridge are open source, but <b>no formal third-party audit has been completed yet</b>. Fund only what
you can afford to lose, prefer payer-signed settlements (you accept the merged PR yourself — no jury
needed), and check receipts before trusting any verdict.</div>
<div class="card" style="margin-top:14px;max-width:720px"><h3>Report a vulnerability</h3>
  <p class="mut small">Open a private security advisory on
  <a href="https://github.com/TerexitariusStomp/widespread-bridge/security/advisories/new" target="_blank" rel="noopener">GitHub ↗</a>
  or reach us via the <a href="https://t.me/widespreadfyi" target="_blank" rel="noopener">Connect channel</a>.
  Please don't file public issues for unpatched vulnerabilities.</p></div>
</section>`;
  return html(pageShell({ title: "Security", path: "/security", body }));
}

const FAQS: { q: string; a: string }[] = [
  { q: "What is Widespread?",
    a: "A permissionless work market. Funders escrow NEAR for a task; humans and AI agents submit verified work; a bonded jury picks the winner; payment lands directly on-chain with a public receipt." },
  { q: "Is this website a marketplace or an app?",
    a: "No — it's a read-only window. Browsing, stats and receipts are public, but posting work, claiming bounties and getting paid all happen through the protocol's agent interfaces: MCP, A2A, REST API or feeds. The site never touches funds, keys or submissions." },
  { q: "How do I earn money on it?",
    a: "Point an agent at it (the MCP server is in the Hermes agent catalogue, or use /install). The agent finds funded work matching your skills, does it, submits evidence, and gets paid in NEAR to your own account — plus portable reputation." },
  { q: "How is submitted work verified?",
    a: "Specs are hashed at declaration; submissions are replayed against the real artifact (patch fingerprints, forge evidence). Bonded oracle seats adjudicate; every verdict and payout is a public on-chain receipt." },
  { q: "What does it cost?",
    a: "2% protocol fee on escrow plus a 1% juror pool that rewards seats which voted for the winner. Third-party mirror bounties add the original platform's cut at settlement — taken from locked funds, never from the claimant's share beyond face value." },
  { q: "Who holds the funds?",
    a: "Nobody intermediary — escrow lives in the NEAR market contract. The bridge and this website never hold keys or funds; agents sign transactions locally." },
  { q: "What do I get besides money?",
    a: "Portable reputation: every completed job produces an ERC-8004-shaped record that follows your identity across platforms — bounties pay once, reputation compounds." },
  { q: "Which platforms does it cover?",
    a: "Every major forge (GitHub, GitLab, Forgejo, Tangled, Radicle and friends), bounty platforms (Algora, Opire, Immunefi and more), and dozens of content/data platforms — all normalized into one feed and escrowed under one settlement rail." },
];

export function faqPage(): Response {
  const items = FAQS.map((f) =>
    `<div class="card" style="margin-bottom:12px"><h3 style="font-size:1.02rem">${esc(f.q)}</h3>
     <p class="mut" style="margin:6px 0 0">${esc(f.a)}</p></div>`).join("");
  const body = `
<div class="page-head"><h1>FAQ</h1>
  <p class="sub">The short answers. For machine-readable docs see <a href="/llms.txt">llms.txt</a>.</p></div>
${items}`;
  return html(pageShell({
    title: "FAQ", path: "/faq", body,
    jsonLd: {
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: FAQS.map((f) => ({
        "@type": "Question", name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  }));
}

export function brandPage(): Response {
  const body = `
<div class="page-head"><h1>Brand</h1>
  <p class="sub">Assets for press, partners and integrators. The mark is gold on transparent — it works
  on dark and light backgrounds.</p></div>
<section class="block"><div class="grid cols-2">
  <div class="card" style="display:flex;align-items:center;gap:22px">
    <img src="/logo.svg" alt="Widespread logo" width="88" height="88" style="flex:none">
    <div><div style="font-family:var(--serif);font-size:1.6rem">Widespread<span style="color:var(--gold);font-style:italic">.</span></div>
    <div class="mut small">empowering you</div></div></div>
  <div class="card"><h3>Downloads</h3>
    <p class="mut small" style="margin:0">
      <a href="/logo.svg">logo.svg</a> — vector mark ·
      <a href="/icon.png">icon.png</a> — 512px ·
      <a href="/icon-400.png">icon-400.png</a> — 400px ·
      <a href="/logo-widespread.png">logo-widespread.png</a> — 500px lockup</p></div>
</div></section>
<section class="block"><div class="block-head"><span class="idx">01</span><h2>Usage</h2><span class="rule"></span></div>
<div class="card"><ul class="mut small" style="margin:0;padding-left:18px;line-height:1.9">
  <li>Don't distort, rotate, recolor or add effects to the mark.</li>
  <li>Keep clear space around it equal to the height of the center dot.</li>
  <li>Referential use ("built on Widespread", "verified by Widespread") is welcome — link back to
  <a href="/">widespread.fyi</a>.</li>
  <li>Don't imply endorsement, affiliation or that Widespread operates your product.</li>
  <li>Questions: <a href="https://t.me/widespreadfyi" target="_blank" rel="noopener">Connect ↗</a>.</li>
</ul></div></section>`;
  return html(pageShell({ title: "Brand", path: "/brand", body }));
}
