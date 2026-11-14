// Conformance tests — core.mjs must produce byte-identical canonical JSON
// and sign messages to the bridge (src/artifacts.ts, src/sightings.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson, sightingSignMessage, buildSighting, textHash,
  encryptState, decryptState, exportEncrypted, importEncrypted,
  sightingEventTemplate, parseSightingContent, corroborationTier, dedupeKey,
  bytesToHex,
} from "../src/core.mjs";

test("canonicalJson matches bridge artifacts.ts semantics", () => {
  // expected strings computed from src/artifacts.ts canonicalJson
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJson([1, "x", null]), '[1,"x",null]');
  assert.equal(canonicalJson("widespread"), '"widespread"');
  assert.equal(canonicalJson(null), "null");
});

test("sightingSignMessage identical to sightings.ts sightingSignMessage", () => {
  const s = { platform: "discourse:x", native_id: "1", url: "https://x/t/1", author: "alice", text: "widespread declare $5", ts: 1730000000, watcher_did: null };
  const msg = sightingSignMessage(s);
  assert.ok(msg.startsWith("widespread-sighting:"));
  const payload = JSON.parse(msg.slice("widespread-sighting:".length));
  assert.deepEqual(Object.keys(payload).sort(), ["author", "native_id", "platform", "text", "ts", "url", "watcher_did"]);
  assert.equal(payload.url, "https://x/t/1");
  assert.equal(payload.watcher_did, null);
});

test("buildSighting + template produce spec-conformant event", () => {
  const content = buildSighting({ platform: "hn", native_id: "42", text: "widespread declare task", ts: 1 });
  const ev = sightingEventTemplate("ab".repeat(32), content, 1730000000);
  assert.equal(ev.kind, 30078);
  assert.deepEqual(ev.tags.find((t) => t[0] === "d"), ["d", "hn:42"]);
  assert.deepEqual(ev.tags.find((t) => t[0] === "t"), ["t", "widespread-sighting"]);
  assert.equal(ev.content, canonicalJson(content));
  const parsed = parseSightingContent(ev);
  assert.equal(parsed.platform, "hn");
  assert.equal(parsed.native_id, "42");
});

test("corroborationTier: lead/corroborated/disputed", () => {
  assert.equal(corroborationTier([{ watcher_id: "a", text_hash: "h1" }]), "lead");
  assert.equal(corroborationTier([{ watcher_id: "a", text_hash: "h1" }, { watcher_id: "b", text_hash: "h1" }]), "corroborated");
  assert.equal(corroborationTier([{ watcher_id: "a", text_hash: "h1" }, { watcher_id: "b", text_hash: "h2" }]), "disputed");
  // same watcher twice ≠ corroboration
  assert.equal(corroborationTier([{ watcher_id: "a", text_hash: "h1" }, { watcher_id: "a", text_hash: "h1" }]), "lead");
});

test("state encrypt/decrypt roundtrip", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const state = { v: 1, watermark: 123, watch_config: { surfaces: [{ platform: "x" }] }, seen_tail: ["a", "b"] };
  const ct = await encryptState(state, key);
  assert.notEqual(ct, canonicalJson(state));
  assert.deepEqual(await decryptState(ct, key), state);
  await assert.rejects(() => decryptState(ct, crypto.getRandomValues(new Uint8Array(32))));
});

test("export/import encrypted blob roundtrip + wrong passphrase", async () => {
  const obj = { v: 1, nsec: "nsec1xyz", watermark: 42 };
  const blob = await exportEncrypted("correct horse", obj);
  assert.deepEqual(await importEncrypted("correct horse", blob), obj);
  await assert.rejects(() => importEncrypted("wrong", blob));
});

test("textHash stable + dedupeKey format", async () => {
  const h = await textHash("hello");
  assert.equal(h, await textHash("hello"));
  assert.match(h, /^[0-9a-f]+$/);
  assert.equal(h.length, 16);
  assert.equal(dedupeKey("p", "1", "w"), "p|1|w");
});
