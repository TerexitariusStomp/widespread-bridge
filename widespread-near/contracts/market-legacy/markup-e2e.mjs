import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "fs";
import os from "os"; import path from "path";
const c = JSON.parse(readFileSync(path.join(os.homedir(), ".widespread-near.json")));
const RPC = "https://rpc.testnet.near.org";
const a = new Account(c.accountId, RPC, new KeyPairSigner(KeyPair.fromString(c.secretKey)));
const GAS = BigInt("30000000000000");
const call = (m, args, d = 0n) => a.callFunction({ contractId: c.accountId, methodName: m, args, gas: GAS, deposit: d });
const dec = (r) => { const v = r?.result ?? r; if (v == null) return null; if (typeof v === "object") return v; const s = typeof v === "string" ? v : Buffer.from(v).toString(); try { return JSON.parse(s); } catch { return s; } };
const mid = dec(await call("createMarket", {
  specHash: "sha256:" + "a".repeat(64), spec: "markup e2e",
  deadline: String(BigInt(Date.now()) * 1000000n + 86400n * 1000000000n),
  acceptanceRule: "x", platformBps: 1000, platformTo: "widespread-dao.near",
}, BigInt("100000000000000000000000")));
console.log("market:", mid);
const cid = dec(await call("shipClaim", {
  marketId: String(mid), claimHash: "sha256:" + "b".repeat(64), actor: "t",
  commits: ["x"], evidence: {}, claimant: c.accountId, attested: true,
}));
console.log("claim:", cid);
const rel = dec(await call("release", { marketId: String(mid), winningClaimId: cid }));
console.log("release:", JSON.stringify(rel));
