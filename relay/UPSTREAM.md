# widespread-relay — upstream sync

This directory is a **git-subtree (squashed) import** of our fork of
[`Spl0itable/nosflare`](https://github.com/Spl0itable/nosflare) (MIT).
It deploys as the `widespread-relay` Cloudflare Worker with the
`nostr-relay` D1 database.

## Our delta vs upstream (~50 LOC, keep it small)

| File | Change |
|---|---|
| `src/config.ts` | relayInfo → "Widespread Relay"; `PAY_TO_RELAY_ENABLED=false`; `AUTH_REQUIRED=false`; `PUBKEY_RATE_LIMIT` 300/min; `REQ_RATE_LIMIT` 120/min; `GLOBAL_EVENT_LIMIT` 200/sec |
| `src/relay-worker.ts` | `ensureDatabase()` — awaited once per isolate before any request (upstream only initialized lazily on the landing-page path → `no such table: events` on fresh D1) |
| `src/durable-object.ts` | `globalEventLimiter` instance + check in the EVENT path |
| `wrangler.toml` | name `widespread-relay`, D1 `nostr-relay` (`a53dffb7-…`), DO binding, cron, no `[limits]` (free plan) |
| `worker.js` | generated bundle (`npm run build`) — regenerate after any src change |

Rule: keep the delta ≤ ~100 LOC so upstream rebases stay trivial.

## Syncing upstream changes

The import was squashed, so `git subtree pull` won't map cleanly. Procedure:

```bash
# 1. fetch upstream nosflare
git clone --depth 50 https://github.com/Spl0itable/nosflare /tmp/nosflare-upstream
cd /tmp/nosflare-upstream && git log --oneline -10   # find the release we forked from

# 2. diff upstream vs our src/ — upstream changes land in the same 4 files
diff -r src /path/to/widespread-bridge/relay/src

# 3. apply upstream changes manually into relay/src/, preserving our delta
#    (the table above is the checklist — verify each entry still applies)

# 4. rebuild + redeploy + re-verify retention
cd relay && npm install && npm run build
CLOUDFLARE_ACCOUNT_ID=46966abcfb8f1245ec055842177edcb2 npx wrangler deploy
# then run the kind-30078 publish/query probe (see repo docs / history)
```

If the delta ever grows painful, the cleaner path is re-forking upstream
and re-applying the 4-file delta — it's small enough to redo in an hour.

## Live deployment

- Worker: `https://widespread-relay.widespread.workers.dev`
- D1: `nostr-relay` (`a53dffb7-e71b-4452-a30a-ef4c5a9ac719`, WNAM)
- Free plan: ~100k req/day, 500MB D1 — see
  `~/.devin/plans/plan-relay-scale.md` for the scale path.
