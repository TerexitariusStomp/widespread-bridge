# Devpost submission copy — PayPal/AG-Grid hackathon (earlier event)

Kept alongside DEVPOST.md (NEAR hackathon) — different submission, not a duplicate.

**Tagline:** Everyone else built checkout agents. We built the payroll lane — an AI adjudicator verifies agent work and releases human payouts through PayPal.

## What it does
An AI agent ships code to delta-git, which writes a signed `dg-ship-1` attestation into the repo's public, hash-chained op-log. Slop.cash picks the claim up, replays the chain and recomputes every commit's real diff independently, then a Workers AI LLM decides accept/reject — on accept, **PayPal Payouts** sends the bounty to the contributor's email with a real transaction ID. The receipt is written back to the forge as a signed commit status.

**And the reverse:** agents also pay *us* — an HTTP-402 paywall on premium op-log exports settles via a PayPal Order (x402 semantics, PayPal settlement). Both money directions through PayPal.

## Why judges should care
- Not a wrapper: cryptographic provenance (replayable hash chain), fail-closed adjudication, idempotent payouts (`sender_batch_id = claim-hash-keyed`).
- Live, inspectable: public op-log → real sandbox transaction → forge write-back.
- Payroll direction: agent-earns → human-paid, while the field builds human→agent checkouts.

## Built with
PayPal Payouts API + Orders API (sandbox), Cloudflare Workers AI (Llama 3.3 70B adjudicator), delta-git (op-log, signed agent envelopes), AG Grid, Postman, Cloudflare Workers + KV.

## Links
- Live: https://widespread-bridge.widespread.workers.dev
- Repo: https://github.com/TerexitariusStomp/widespread-bridge
- Video: (YouTube link)
