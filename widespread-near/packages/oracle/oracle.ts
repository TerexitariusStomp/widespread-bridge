// oracle.ts — the bridge's adjudicator seat, as an on-chain oracle.
//
// When the market contract sees an `accept` verdict signed by a registered
// oracle pubkey it releases escrow — no payer signature needed. The bridge
// signs `wide-verdict|{marketId}|{claimHash}|{verdict}|{deadline}` with an
// Ed25519 key whose pubkey is registered via registerOracle. Combined with
// the NEAR AI Cloud provider_tee signature on the model output, the chain
// of custody is: TEE-run inference → signed oracle verdict → escrow release.

export interface OracleConfig {
  contract: string;         // NEAR_CONTRACT account id
  rpc: string;              // NEAR_RPC_URL
  accountId: string;        // caller account (holds the NEAR to pay gas)
  secretKey: string;        // ed25519:... — signs the NEAR tx
  oracleKeyHex: string;     // 32-byte seed hex — the oracle's own signing key
  oraclePubkeyHex: string;  // matching pubkey, registered via registerOracle
}

const te = new TextEncoder();
const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function ed25519Sign(msg: string, seedHex: string): Promise<string> {
  const seed = Uint8Array.from(seedHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    // PKCS8 wrap for raw Ed25519 seed (DER prefix).
    new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,
                    0x04,0x22,0x04,0x20, ...seed]),
    { name: "Ed25519" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("Ed25519", key, te.encode(msg));
  return toHex(new Uint8Array(sig));
}

/** The oracle verdict envelope — exactly what release() binds on-chain. */
export async function signVerdict(
  cfg: OracleConfig,
  marketId: string,
  claimHash: string,
  verdict: "accept" | "reject",
  deadline: string,
): Promise<{ sig: string; pubkey: string }> {
  const msg = `wide-verdict|${marketId}|${claimHash}|${verdict}|${deadline}`;
  const sig = await ed25519Sign(msg, cfg.oracleKeyHex);
  return { sig, pubkey: cfg.oraclePubkeyHex };
}

/** Build the oracle config from env — the oracle's pubkey is provisioned
 * alongside its seed (a one-time `src/oracle-keygen.js` emits the pair). */
export function oracleEnv(env: {
  NEAR_CONTRACT?: string; NEAR_RPC_URL?: string;
  ORACLE_ACCOUNT?: string; ORACLE_SECRET_KEY?: string;
  ORACLE_SEED_HEX?: string; ORACLE_PUBKEY_HEX?: string;
}): OracleConfig | null {
  if (!env.NEAR_CONTRACT || !env.ORACLE_SEED_HEX || !env.ORACLE_PUBKEY_HEX) {
    return null;
  }
  return {
    contract: env.NEAR_CONTRACT,
    rpc: env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
    accountId: env.ORACLE_ACCOUNT ?? "",
    secretKey: env.ORACLE_SECRET_KEY ?? "",
    oracleKeyHex: env.ORACLE_SEED_HEX,
    oraclePubkeyHex: env.ORACLE_PUBKEY_HEX,
  };
}
