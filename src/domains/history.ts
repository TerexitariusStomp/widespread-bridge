// history.ts — bound-profile history + style/theme similarity.
//
// Style matching is a SIMILARITY SCORE fed to adjudication — never a gate.
// 2025 stylometry/AI-detection literature is unambiguous: detectors degrade
// to near-random under style shift and perfect authorship detection is
// impossible. So this module produces a 0..1 similarity signal with a
// transparent feature basis; verdicts judge outcomes and spec fit, not
// presumed authorship origin. "Outcomes, not origins."
//
// History is fetched only for explicitly bound, publicly readable handles
// — never scraped, never stored raw; derived features + hashes only.

import type { Env, SocialEnv } from "../types";

export interface TimelineSample {
  platform: string;
  handle: string;
  samples: string[];
  gated?: boolean;
  fetched_at: number;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/https?:\/\/\S+/g, "").trim();

/** Pull the most recent public posts for a bound handle. Every platform
 * fails soft — an unreachable timeline yields zero samples, not an error. */
export async function fetchTimeline(env: Env, platform: string, handle: string, limit = 30): Promise<TimelineSample> {
  const p = platform.toLowerCase();
  const out: TimelineSample = { platform: p, handle, samples: [], fetched_at: Date.now() };

  if (p === "bluesky" || p === "atproto") {
    const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=${Math.min(limit, 100)}&filter=posts_no_replies`)
      .catch(() => null);
    const j = (await r?.json().catch(() => null)) as { feed?: { post?: { record?: { text?: string } } }[] } | null;
    out.samples = (j?.feed ?? []).map((f) => f.post?.record?.text ?? "").filter(Boolean).slice(0, limit);
    return out;
  }

  if (p === "mastodon" || p === "activitypub") {
    const [user, inst] = handle.replace(/^@/, "").includes("@")
      ? handle.replace(/^@/, "").split("@") : [handle, ((env as SocialEnv).MASTODON_INSTANCES ?? "mastodon.social").split(",")[0].trim()];
    const acct = await fetch(`https://${inst}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`).then((r) => r.json()).catch(() => null) as { id?: string } | null;
    if (!acct?.id) { out.gated = true; return out; }
    const st = await fetch(`https://${inst}/api/v1/accounts/${acct.id}/statuses?limit=${Math.min(limit, 40)}&exclude_replies=true`)
      .then((r) => r.json()).catch(() => null) as { content?: string }[] | null;
    out.samples = (Array.isArray(st) ? st : []).map((s) => strip(s.content ?? "")).filter(Boolean).slice(0, limit);
    return out;
  }

  if (p === "nostr") {
    try {
      const { SimplePool, nip19 } = await import("nostr-tools");
      const pk = /^npub1/.test(handle) ? (nip19.decode(handle).data as string) : handle;
      const relays = ((env as SocialEnv).NOSTR_RELAYS ?? "wss://relay.damus.io,wss://nos.lol").split(",").map((x) => x.trim());
      const pool = new SimplePool();
      const events = await pool.querySync(relays, { kinds: [1], authors: [pk], limit: Math.min(limit, 50) }).catch(() => []);
      pool.close(relays);
      out.samples = (events ?? []).sort((a, b) => b.created_at - a.created_at).map((e) => e.content).slice(0, limit);
    } catch { out.gated = true; }
    return out;
  }

  if (p === "hackernews" || p === "hn") {
    const j = await fetch(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,author_${encodeURIComponent(handle)}&hitsPerPage=${Math.min(limit, 50)}`)
      .then((r) => r.json()).catch(() => null) as { hits?: { comment_text?: string }[] } | null;
    out.samples = (j?.hits ?? []).map((h) => strip(h.comment_text ?? "")).filter(Boolean).slice(0, limit);
    return out;
  }

  if (p === "x" || p === "twitter") {
    if (!env.X_BEARER_TOKEN) { out.gated = true; return out; }
    const j = await fetch(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(`from:${handle}`)}&max_results=${Math.min(Math.max(limit, 10), 100)}&tweet.fields=text`,
      { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } }).then((r) => r.json()).catch(() => null) as { data?: { text?: string }[] } | null;
    out.samples = (j?.data ?? []).map((t) => t.text ?? "").filter(Boolean);
    if (!out.samples.length) out.gated = true;
    return out;
  }

  // linkedin / instagram / facebook / tiktok / github etc. — no reliable
  // public timeline API; caller falls back to spec-only adjudication.
  out.gated = true;
  return out;
}

// ------------------------------------------------------ similarity features

const STOP = new Set("the a an and or but of to in on for with is are was were be been it its this that i you we they he she at by as from not no so do did will would can could".split(" "));

const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'#@ ]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

interface Features {
  avg_sentence_len: number;
  avg_word_len: number;
  vocab: Set<string>;
  top_terms: string[];
  hashtag_rate: number;
  exclaim_rate: number;
  question_rate: number;
}

function features(texts: string[]): Features {
  const all = texts.join("\n");
  const sentences = all.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const vocab = new Set(tokens(all));
  const freq = new Map<string, number>();
  for (const w of tokens(all)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const words = all.split(/\s+/).filter(Boolean);
  return {
    avg_sentence_len: sentences.length ? words.length / sentences.length : 0,
    avg_word_len: words.length ? words.join("").length / words.length : 0,
    vocab,
    top_terms: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w),
    hashtag_rate: words.length ? words.filter((w) => w.startsWith("#")).length / words.length : 0,
    exclaim_rate: all.length ? (all.match(/!/g) ?? []).length / all.length : 0,
    question_rate: all.length ? (all.match(/\?/g) ?? []).length / all.length : 0,
  };
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

export interface StyleScore {
  /** 0..1 similarity — a scoring input, never a hard gate. */
  score: number;
  basis: {
    n_samples: number;
    vocab_overlap: number;
    sentence_len_delta: number;
    shared_top_terms: string[];
    gated?: boolean;
  };
  note: string;
}

/** Compare a deliverable against the bound profile's public history.
 * Weights: vocabulary overlap 0.5, shared signature terms 0.2, sentence
 * length 0.2, punctuation/hashtag habits 0.1. Deliberately coarse —
 * precision here would be false confidence. */
export function styleScore(deliverable: string, samples: string[], gated = false): StyleScore {
  if (!samples.length) {
    return { score: 0, basis: { n_samples: 0, vocab_overlap: 0, sentence_len_delta: 0, shared_top_terms: [], gated }, note: gated ? "profile history gated — no style signal" : "no public history" };
  }
  const ref = features(samples);
  const del = features([deliverable]);
  const vocab_overlap = jaccard(ref.vocab, del.vocab);
  const shared = del.top_terms.filter((w) => ref.top_terms.includes(w));
  const lenDelta = ref.avg_sentence_len ? Math.abs(del.avg_sentence_len - ref.avg_sentence_len) / ref.avg_sentence_len : 1;
  const lenScore = Math.max(0, 1 - lenDelta);
  const punctScore = Math.max(0, 1 - (Math.abs(ref.exclaim_rate - del.exclaim_rate) + Math.abs(ref.question_rate - del.question_rate)) * 50);
  const hashScore = ref.hashtag_rate > 0.01 ? (del.hashtag_rate > 0.01 ? 1 : 0) : 0.5;
  const score = 0.5 * vocab_overlap + 0.2 * (shared.length / Math.max(1, Math.min(10, ref.top_terms.length)))
    + 0.2 * lenScore + 0.1 * (0.5 * punctScore + 0.5 * hashScore);
  return {
    score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    basis: {
      n_samples: samples.length, vocab_overlap: Math.round(vocab_overlap * 1000) / 1000,
      sentence_len_delta: Math.round(lenDelta * 100) / 100, shared_top_terms: shared.slice(0, 8),
    },
    note: "similarity signal only — not an authorship or AI-origin determination",
  };
}
