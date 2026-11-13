// Ported from LocalChimera (AGPL-3.0) — workers/coordinator/src/didkey.ts — © LocalChimera contributors

/**
 * did:key interop — ed25519 verification for `did:key:z<multibase>` subjects.
 *
 * The did:key method encodes the public key directly in the DID: a
 * multibase (base58btc, 'z' prefix) of the multicodec-prefixed key
 * (0xed01 = ed25519-pub). No resolver or network call is needed — the DID
 * document IS the key. Nodes bind by signing `widespread-bind:<volunteerId>`
 * with the private key; we verify against the decoded public key.
 */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58btc string (no multibase 'z' prefix — strip it first). */
export function base58Decode(s: string): Uint8Array | null {
  if (!s.length) return null;
  // Count leading '1's — each is a zero byte.
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  bytes.reverse();
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

/** Encode bytes as base58btc — symmetric with base58Decode; used to mint
 *  did:key identifiers from raw ed25519 pubkeys (tests + node registration). */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  digits.reverse();
  return "1".repeat(zeros) + digits.map((d) => B58_ALPHABET[d]).join("");
}

/** did:key string for a raw 32-byte ed25519 public key. */
export function didKeyFromPublicKey(pub: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(pub, 2);
  return `did:key:z${base58Encode(prefixed)}`;
}

/** Extract the raw 32-byte ed25519 public key from a did:key string, or null. */
export function didKeyPublicKey(did: string): Uint8Array | null {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!m) return null;
  const decoded = base58Decode(m[1]);
  if (!decoded) return null;
  // Multicodec prefix for ed25519-pub is 0xED 0x01 (varint 0xED).
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return null;
  return decoded.slice(2);
}

async function importEd25519(pub: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", pub as BufferSource, "Ed25519", false, ["verify"]);
}

/** Verify an ed25519 signature over `message` for a `did:key` subject. */
export async function verifyDidKey(did: string, message: string, sig: Uint8Array): Promise<boolean> {
  const pub = didKeyPublicKey(did);
  if (!pub || pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await importEd25519(pub);
    return await crypto.subtle.verify(
      "Ed25519", key, sig as BufferSource, new TextEncoder().encode(message) as BufferSource);
  } catch {
    return false;
  }
}

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC4648-lower base32, no padding — the CIDv1 'b' multibase encoding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0, bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buf >> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buf << (5 - bits)) & 0x1f];
  return out;
}

/** Decode an EIP-1577 contenthash to a CID string when it's the common
 *  IPFS shape: e3 01 (ipfs-ns multicodec) + raw CIDv1 bytes, which are
 *  already a binary CID — just multibase-encode them. Returns null for
 *  unrecognized codecs (ipns/skynet/etc.). */
export function contentHashToCid(raw: string): string | null {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (hex.length < 4 || hex.length % 2 !== 0) return null;
  if (!hex.toLowerCase().startsWith("e301")) return null;
  const bytes = new Uint8Array(hex.length / 2 - 2);
  for (let i = 4; i < hex.length; i += 2) {
    bytes[(i - 4) / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return "b" + base32Encode(bytes);
}

/** Node sends `did:key:z…` + `sig` as base64 or hex — normalize to bytes. */
export function decodeSig(sig: string): Uint8Array | null {
  if (/^[0-9a-fA-F]+$/.test(sig) && sig.length === 128) {
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) out[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  try {
    const bin = atob(sig);
    if (bin.length === 64) {
      const out = new Uint8Array(64);
      for (let i = 0; i < 64; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch { /* not base64 */ }
  return null;
}
