// webhooks.ts — push ingestion for platforms that offer webhooks.
// Payloads are normalized into Sightings and fed through the same oracle
// pipeline (ingestSighting) as watcher reports — one trust model for all
// transports. Platform-authenticated events get source:"push" weight.

import type { Env } from "./types";
import { ingestSighting, type Sighting, type IngestResult } from "./sightings";

const enc = new TextEncoder();

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Normalized { sighting?: Sighting; error?: string }

/** Slack Events API: verify v0 HMAC over `v0:{ts}:{body}`; extract message
 *  text + channel + ts as the native object. */
async function normalizeSlack(env: Env, req: Request, raw: string): Promise<Normalized> {
  const secret = env.SLACK_SIGNING_SECRET;
  if (!secret) return { error: "slack webhooks not configured" };
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig) return { error: "missing slack signature headers" };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { error: "stale timestamp" };
  const expected = "v0=" + await hmacSha256Hex(secret, `v0:${ts}:${raw}`);
  if (!(await timingSafeEqual(expected, sig))) return { error: "bad signature" };
  let j: { event?: { type?: string; text?: string; channel?: string; ts?: string; user?: string; subtype?: string }; challenge?: string };
  try { j = JSON.parse(raw); } catch { return { error: "bad json" }; }
  if (j.challenge) return { error: "__challenge__" }; // url_verification handshake
  const ev = j.event;
  if (!ev?.text || !ev.channel || !ev.ts) return {};
  if (ev.subtype && ev.subtype !== "file_share") return {};
  return { sighting: {
    platform: "slack", native_id: `${ev.channel}:${ev.ts}`, url: `https://slack.com/archives/${ev.channel}/p${ev.ts.replace(".", "")}`,
    author: ev.user, text: ev.text, ts: Math.floor(Number(ev.ts) * 1000), source: "push",
  } };
}

/** Discord interactions/messages: ed25519 signature over timestamp+body
 *  verified against DISCORD_PUBLIC_KEY (hex). */
async function normalizeDiscord(env: Env, req: Request, raw: string): Promise<Normalized> {
  const pubHex = env.DISCORD_PUBLIC_KEY;
  if (!pubHex) return { error: "discord webhooks not configured" };
  const ts = req.headers.get("x-signature-timestamp") ?? "";
  const sigHex = req.headers.get("x-signature-ed25519") ?? "";
  if (!ts || !sigHex) return { error: "missing discord signature headers" };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { error: "stale timestamp" };
  const msg = enc.encode(ts + raw);
  let sig: Uint8Array;
  try { sig = Uint8Array.from(sigHex.match(/../g)!.map((h) => parseInt(h, 16))); } catch { return { error: "bad signature encoding" }; }
  let pub: Uint8Array;
  try { pub = Uint8Array.from(pubHex.match(/../g)!.map((h) => parseInt(h, 16))); } catch { return { error: "bad public key" }; }
  if (pub.length !== 32 || sig.length !== 64) return { error: "bad signature" };
  try {
    const key = await crypto.subtle.importKey("raw", pub as BufferSource, "Ed25519", false, ["verify"]);
    if (!(await crypto.subtle.verify("Ed25519", key, sig as BufferSource, msg as BufferSource))) return { error: "bad signature" };
  } catch {
    return { error: "bad signature" };
  }
  interface DiscordMessage { id?: string; channel_id?: string; content?: string; author?: { username?: string }; timestamp?: string }
  let j: { type?: number; data?: { content?: string }; message?: DiscordMessage };
  try { j = JSON.parse(raw); } catch { return { error: "bad json" }; }
  // Gateway MESSAGE_CREATE (type 4) carries {message}; interactions don't.
  const m: DiscordMessage | undefined = j.message ?? (j.type === 4 ? (j as unknown as DiscordMessage) : undefined);
  const content = m?.content ?? j.data?.content;
  const id = m?.id;
  const channel = m?.channel_id;
  if (!content || !id || !channel) return {};
  return { sighting: {
    platform: "discord", native_id: `${channel}:${id}`,
    url: `https://discord.com/channels/@me/${channel}/${id}`,
    author: m?.author?.username, text: content,
    ts: m?.timestamp ? Date.parse(m.timestamp) : Date.now(), source: "push",
  } };
}

/** Generic push: shared token in ?token= (constant-time compare). Body is
 *  expected to be a sighting JSON (platform/native_id/text required). */
async function normalizeGeneric(env: Env, url: URL, raw: string): Promise<Normalized> {
  const token = env.WEBHOOK_TOKEN;
  if (!token) return { error: "generic webhooks not configured" };
  const given = url.searchParams.get("token") ?? "";
  if (!(await timingSafeEqual(given, token))) return { error: "bad token" };
  let j: Partial<Sighting>;
  try { j = JSON.parse(raw); } catch { return { error: "bad json" }; }
  if (!j.platform || !j.native_id || !j.text) return { error: "platform, native_id, text required" };
  return { sighting: { ...j, source: "push" } as Sighting };
}

export async function handleWebhook(env: Env, platform: string, req: Request): Promise<{ status: number; body: unknown }> {
  const url = new URL(req.url);
  const raw = await req.text();
  let n: Normalized;
  try {
    if (platform === "slack") n = await normalizeSlack(env, req, raw);
    else if (platform === "discord") n = await normalizeDiscord(env, req, raw);
    else if (platform === "generic") n = await normalizeGeneric(env, url, raw);
    else return { status: 404, body: { error: "unknown platform" } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
  if (n.error === "__challenge__") return { status: 200, body: JSON.parse(raw).challenge };
  if (n.error) {
    const status = /not configured/.test(n.error) ? 503
      : /signature|token|stale|missing/.test(n.error) ? 401 : 400;
    return { status, body: { error: n.error } };
  }
  if (!n.sighting) return { status: 200, body: { ok: true, ingested: 0 } };
  const r: IngestResult = await ingestSighting(env, n.sighting);
  return r.ok
    ? { status: 200, body: { ok: true, tier: r.tier, duplicate: r.duplicate } }
    : { status: 429, body: { error: r.error } };
}
