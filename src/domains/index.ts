// Domain router: market.domain picks the pack. `auto` sniffs the ref —
// a claim can always fall back to platform-url or payer-accept.
import { packs } from "./social";
import { computePacks } from "./compute";
import { lifeCapacityPacks } from "./lifecapacity";
import type { DomainPack, MarketRef, ClaimRef, ValidateResult } from "./types";

const allPacks = [...packs, ...computePacks, ...lifeCapacityPacks];

export function getDomain(name: string | undefined): DomainPack | null {
  if (!name) return null;
  const n = name.toLowerCase();
  return allPacks.find((p) => p.name === n || p.name.startsWith(n)) ?? null;
}

const pack = (name: string) => allPacks.find((p) => p.name === name)!;

/** Guess the pack from the artifact ref when the market doesn't declare one. */
export function sniffDomain(ref: string): DomainPack {
  const r = ref.toLowerCase();
  if (/^btfs:\/\//.test(r) || /\/btfs\/[a-z0-9]{20,}/.test(r)) return pack("btfs-artifact");
  if (/^ipfs:\/\//.test(r) || /\/ipfs\/(qm|b[a-z2-7])[a-z0-9]{20,}/.test(r)) return pack("ipfs-artifact");
  if (/^rcpt:\/\//.test(r)) return pack("resource-receipt");
  if (/^widespread:\/\/job\/|^job:|\/api\/jobs\//.test(r)) return pack("runner-job");
  if (/bsky\.app\/profile|at:\/\//.test(r)) return pack("bluesky-post");
  if (/(x|twitter)\.com\/\w+\/status/.test(r)) return pack("x-post");
  if (/youtube\.com|youtu\.be/.test(r)) return pack("youtube");
  if (/tiktok\.com/.test(r)) return pack("tiktok-video");
  if (/kick\.com/.test(r)) return pack("kick-clip");
  if (/dev\.to\/[\w-]+\/[\w-]+/.test(r)) return pack("devto-article");
  if (/hashnode\.(dev|com)|\.hashnode\.dev/.test(r)) return pack("hashnode-post");
  if (/peakd\.com\/@|hive\.blog\/@/.test(r)) return pack("hive-post");
  if (/steemit\.com\/@|steempeak\.com\/@/.test(r)) return pack("steem-post");
  if (/audius\.co\//.test(r)) return pack("audius-track");
  if (/blogspot\.|\.blogger\.com/.test(r)) return pack("blogger-post");
  if (/substack\.com\/p\//.test(r)) return pack("substack-post");
  if (/pixelfed\.\w+\//.test(r)) return pack("pixelfed-post");
  if (/\/notes\/[\w]+$/.test(r)) return pack("misskey-note");
  if (/\/w\/[\w-]+$|\/videos\/watch\//.test(r)) return pack("peertube-video");
  if (/\/(post|comment)\/\d+(\?|$)/.test(r)) return pack("lemmy-post");
  if (/@[\w.-]+\/\d+|mastodon|\.social\/@|hachyderm|fosstodon|infosec\.exchange/.test(r)) return pack("mastodon-post");
  return pack("platform-url");
}

export async function validateDomain(
  market: MarketRef, claim: ClaimRef, env: Record<string, string | undefined>,
): Promise<ValidateResult & { pack: string }> {
  const pack = getDomain(market.domain) ?? sniffDomain(claim.ref);
  if (!pack) return { failures: [`unknown domain ${market.domain}`], evidence: {}, pack: "none" };
  const res = await pack.validate({ market, claim }, { env, fetch });
  return { ...res, pack: pack.name };
}
