// Domain router: market.domain picks the pack. `auto` sniffs the ref —
// a claim can always fall back to platform-url or payer-accept.
import { packs } from "./social";
import type { DomainPack, MarketRef, ClaimRef, ValidateResult } from "./types";

export function getDomain(name: string | undefined): DomainPack | null {
  if (!name) return null;
  const n = name.toLowerCase();
  return packs.find((p) => p.name === n || p.name.startsWith(n)) ?? null;
}

/** Guess the pack from the artifact ref when the market doesn't declare one. */
export function sniffDomain(ref: string): DomainPack {
  const r = ref.toLowerCase();
  if (/bsky\.app\/profile|at:\/\//.test(r)) return packs[0];
  if (/(x|twitter)\.com\/\w+\/status/.test(r)) return packs[2];
  if (/youtube\.com|youtu\.be/.test(r)) return packs[3];
  if (/@[\w.-]+\/\d+|mastodon|\.social\/@|hachyderm|fosstodon|infosec\.exchange/.test(r)) return packs[1];
  return packs[4]; // platform-url
}

export async function validateDomain(
  market: MarketRef, claim: ClaimRef, env: Record<string, string | undefined>,
): Promise<ValidateResult & { pack: string }> {
  const pack = getDomain(market.domain) ?? sniffDomain(claim.ref);
  if (!pack) return { failures: [`unknown domain ${market.domain}`], evidence: {}, pack: "none" };
  const res = await pack.validate({ market, claim }, { env, fetch });
  return { ...res, pack: pack.name };
}
