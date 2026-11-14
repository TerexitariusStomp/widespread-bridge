// Governance conformance — proto.mjs ratification + adapter collection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, verifyEvent, generateSecretKey, getPublicKey } from "../vendor/nostr-tools.bundle.mjs";
import {
  metaEventTemplate, adapterEventTemplate, parseMetaPayload,
  ratifyMeta, collectAdapters, T_PROTOCOL_META, T_ADAPTER,
} from "../src/proto.mjs";

const sign = (sk, template) => finalizeEvent(template, sk);
const mkMeta = (stewards, threshold, seq = 0, prev = null) => ({
  v: 1, spec: "widespread-discovery/1", seq,
  prev_stewards: prev, stewards, threshold,
  relay_hints: ["wss://relay.snort.social"],
});

test("meta payload validation rejects malformed", () => {
  assert.equal(parseMetaPayload(null), null);
  assert.equal(parseMetaPayload({ v: 2 }), null);
  assert.equal(parseMetaPayload({ v: 1, seq: 0, stewards: ["zz"], threshold: 1 }), null);
  assert.equal(parseMetaPayload({ v: 1, seq: 0, stewards: ["a".repeat(64)], threshold: 2 }), null); // thr > N
  const ok = parseMetaPayload(mkMeta(["a".repeat(64)], 1));
  assert.equal(ok.stewards.length, 1);
});

test("ratification: threshold of required set, newest seq wins", () => {
  const sks = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
  const pks = sks.map(getPublicKey);
  const payload = mkMeta(pks, 2);
  const evs = sks.slice(0, 2).map((sk) => sign(sk, metaEventTemplate(getPublicKey(sk), payload)));
  const best = ratifyMeta(evs, verifyEvent);
  assert.equal(best.signers.length, 2);
  assert.equal(best.seq, 0);
});

test("ratification: below threshold stays pending", () => {
  const sks = [generateSecretKey(), generateSecretKey()];
  const pks = sks.map(getPublicKey);
  const payload = mkMeta(pks, 2);
  const evs = [sign(sks[0], metaEventTemplate(pks[0], payload))];
  assert.equal(ratifyMeta(evs, verifyEvent), null);
});

test("ratification: outsiders cannot vote", () => {
  const sks = [generateSecretKey(), generateSecretKey()];
  const pks = sks.map(getPublicKey);
  const outsider = generateSecretKey();
  const opposite = mkMeta(pks, 2);
  const evs = [
    sign(sks[0], metaEventTemplate(pks[0], opposite)),
    sign(outsider, metaEventTemplate(getPublicKey(outsider), opposite)),
  ];
  assert.equal(ratifyMeta(evs, verifyEvent), null);
});

test("amendment: prev_stewards gates the transition", () => {
  const old = [generateSecretKey(), generateSecretKey()];
  const oldPks = old.map(getPublicKey);
  const neu = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
  const neuPks = neu.map(getPublicKey);
  // seq1 payload: ratified by OLD set, installs NEW set
  const payload = mkMeta(neuPks, 2, 1, oldPks);
  const evs = old.map((sk) => sign(sk, metaEventTemplate(getPublicKey(sk), payload)));
  const best = ratifyMeta(evs, verifyEvent);
  assert.ok(best, "old-set signatures should ratify the amendment");
  assert.deepEqual(best.payload.stewards, neuPks);
  // new set alone cannot ratify it (they're not prev_stewards)
  const evs2 = neu.slice(0, 2).map((sk) => sign(sk, metaEventTemplate(getPublicKey(sk), payload)));
  assert.equal(ratifyMeta(evs2, verifyEvent), null);
});

test("tampered event signature rejected", () => {
  const sk = generateSecretKey(); const pk = getPublicKey(sk);
  const payload = mkMeta([pk], 1);
  const ev = sign(sk, metaEventTemplate(pk, payload));
  // JSON round-trip: relay-fetched events never carry nostr-tools'
  // in-memory verified-symbol cache, and a naive object spread would.
  const forged = JSON.parse(JSON.stringify({ ...ev, content: JSON.stringify({ ...payload, note: "forged" }) }));
  assert.equal(ratifyMeta([forged], verifyEvent), null);
});

test("adapter events collect latest per id", () => {
  const sk = generateSecretKey(); const pk = getPublicKey(sk);
  const m1 = { id: "sha256:aaa", platform: "discourse", ops: [] };
  const m2 = { id: "sha256:aaa", platform: "discourse", ops: [{ name: "x" }] };
  const e1 = sign(sk, adapterEventTemplate(pk, m1));
  const e2 = { ...sign(sk, adapterEventTemplate(pk, m2)), created_at: e1.created_at + 10 };
  const ads = collectAdapters([e1, e2]);
  assert.equal(ads.get("sha256:aaa").manifest.ops.length, 1);
  assert.equal(ads.size, 1);
});
