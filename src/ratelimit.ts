// ratelimit.ts — best-effort fixed-window rate limiting on KV.
// KV has no atomic increment; read-then-write races under concurrency, so
// limits are approximate (± burst). The point is shedding abuse, not
// exactness — the paid-plan upgrade path is the precise answer.

import type { Env } from "./types";

export interface LimitResult { ok: boolean; retryAfter: number; remaining: number }

/** Fixed per-minute window for `key` — e.g. ratelimit:evaluate:1.2.3.4:1732…
 * `perMin` max requests per minute; `perDay` optional global daily cap
 * (key "" = global bucket shared across callers). */
export async function checkLimit(
  env: Env,
  bucket: string,
  key: string,
  perMin: number,
  perDay?: number,
): Promise<LimitResult> {
  const now = Date.now();
  if (perDay) {
    const day = Math.floor(now / 86_400_000);
    const dKey = `rl:day:${bucket}:${day}`;
    const dCount = Number(await env.CLAIMS.get(dKey).catch(() => 0)) || 0;
    if (dCount >= perDay) {
      return { ok: false, retryAfter: Math.ceil((86400000 - (now % 86400000)) / 1000), remaining: 0 };
    }
    await env.CLAIMS.put(dKey, String(dCount + 1), { expirationTtl: 172800 }).catch(() => {});
  }
  const minute = Math.floor(now / 60_000);
  const mKey = `rl:min:${bucket}:${key}:${minute}`;
  const count = Number(await env.CLAIMS.get(mKey).catch(() => 0)) || 0;
  if (count >= perMin) {
    return { ok: false, retryAfter: Math.ceil((60000 - (now % 60000)) / 1000), remaining: 0 };
  }
  await env.CLAIMS.put(mKey, String(count + 1), { expirationTtl: 300 }).catch(() => {});
  return { ok: true, retryAfter: 0, remaining: perMin - count - 1 };
}

export function rateLimited(retryAfter: number): Response {
  return Response.json(
    { error: "rate_limited", retry_after_s: retryAfter },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

/** Caller key: CF-Connecting-IP when present, else a token/did arg, else "anon". */
export function callerKey(req: Request, fallback?: string): string {
  return req.headers.get("cf-connecting-ip") ?? fallback ?? "anon";
}
