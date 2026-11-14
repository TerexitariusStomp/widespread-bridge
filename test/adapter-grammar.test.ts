// adapter-grammar.test.ts — parity between widespread-adapter/1 grammar
// blocks and the socialfeed ingestion regexes. A manifest's declared
// grammar MUST produce strings the bridge actually ingests — otherwise
// receipts/claims posted through an adapter silently never land.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DECL_RE, CLAIM_RE, RECEIPT_RE } from "../src/socialfeed";

// Cross-repo parity test: reads the sibling near-hermes-browser checkout.
// Skips when the sibling isn't present (CI, tarball installs).
const SEED_DIR = join(__dirname, "../../near-hermes-browser/adapters/seed");
const SEED_PRESENT = existsSync(SEED_DIR);

interface Grammar { declaration?: string; claim?: string; receipt?: string }

function instantiate(tpl: string, hash: string): string {
  return tpl.replace(/<hash>|<id>/g, hash);
}

describe.skipIf(!SEED_PRESENT)("adapter grammar ↔ socialfeed parity", () => {
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);

  for (const f of files) {
    it(`${f} grammar strings match ingestion regexes`, () => {
      const m = JSON.parse(readFileSync(join(SEED_DIR, f), "utf8"));
      const g: Grammar | undefined = m.grammar;
      if (!g) return; // marketplace/browser-tier manifests carry no grammar
      const hash = "a1b2c3d4";
      if (g.declaration) {
        // Declaration templates may be multi-line; at least one line must
        // produce a DECL_RE match when instantiated.
        const text = instantiate(g.declaration, hash)
          .replace(/<domain>/g, "test")
          .replace(/<n>/g, "5").replace(/<ccy>/g, "USD")
          .replace(/<text>/g, "spec");
        expect(DECL_RE.test(text)).toBe(true);
      }
      if (g.claim) {
        const text = instantiate(g.claim, hash);
        expect(CLAIM_RE.test(text)).toBe(true);
      }
      if (g.receipt) {
        const text = instantiate(g.receipt, "rcpt://test/" + hash);
        expect(RECEIPT_RE.test(text)).toBe(true);
      }
    });
  }
});
