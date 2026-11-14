# Intentional Hats — collaborator interface

Hats Protocol-style role/permission layer for agent commerce, native to NEAR.
Deployed: `intentional-hats-632291.testnet` (testnet).

Hats authorize agents; Widespread markets verify work; futarchy governs;
Intents/Poidh settle cross-chain.

## Concepts

- **Org → hat tree.** `createOrg` → `createHat({orgId, parentHatId, name,
  permissions, identityRef, constitutionRef})`. Hats form a hierarchy.
- **Wearer** — the NEAR account (or agent key) currently holding a hat.
  `assignHat` / `revokeHat`.
- **Accountability** — `accountableTo` links a hat to its parent hat;
  the parent/top wearer can revoke children. This is the Hats Protocol
  mechanic: authority can be clawed back when misused.
- **Permissions** — capability scopes checked on-chain via `hasScope`:
  `market:claim`, `market:create`, `forge:ship`, `verify:adjudicate`,
  `treasury:pay`, `sign:<chain>`, `*`.
- **Foreign identity** — `setForeign({hatId, chain, path, keyType})` stores a
  chain-signatures derivation path. `requestForeignSig` asks
  `v1.signer-prod.testnet` (testnet) / `v1.signer` (mainnet) MPC to sign;
  the callback records the result. The wearer never holds a foreign key.
- **Stance** — `setStance({hatId, prefs, vetoes, constitutionRef})`. The
  bridge scores `wouldSupport` deterministically; `constitutionRef` may
  point at a live deliberation endpoint (Simocracy sim / mechanism
  service) for delegated verdicts.
- **Payouts** — `requestPayout` records an intents-leg intent;
  `confirmPayout` closes it with the settlement receipt.

## Event log (the team interface)

Every mutation emits a structured `near.log` event — game layers and
identity systems should consume these, not storage internals:

| Event | Fields |
|---|---|
| `hat.minted` | hatId, orgId, name, parentHatId, wearer |
| `hat.assigned` | hatId, wearer |
| `hat.revoked` | hatId, by, reason |
| `hat.scope.set` | hatId, permissions |
| `hat.foreign.set` | hatId, chain, path, keyType |
| `hat.stance.set` | hatId, prefs, vetoes, constitutionRef |
| `hat.payout.requested` | hatId, payoutId, amount, dest |
| `hat.payout.confirmed` | hatId, payoutId, receipt |
| `hat.sig.requested` | hatId, sigId, payload, path, keyType |
| `hat.sig.completed` | hatId, sigId, result |

## identityRef / constitutionRef formats

- `erc8004:<chainId>:<agentId>` — ERC-8004 agent identity (registries are
  CREATE2-identical on all EVM mainnets; see bridge `ERC8004_REGISTRIES`)
- `at://<did>/<record>` — ATProto record (Simocracy sims, style, constitution)
- bare `name.near` / `name.testnet` — NEAR account
- `https://…` — live deliberation endpoint (delegated stance)

## Bridge surface (widespread-bridge Worker)

- `GET /api/hats?org=<id>` — org + hat chart
- `GET /api/hats/:id?scope=<scope>` — hat detail + on-chain scope check
- `GET /api/hats/:id/foreign` — chain-sigs derivation params + signer root key
- `POST /api/hats/:id/stance-check` `{spec, verdicts?, delegate?}` —
  support verdict, earned-stance adjustment, delegated deliberation,
  parsed identity ref
- `GET /api/hats/:id/opportunities` — funded markets ranked
  alignment × reward / estCost (vetoes excluded)
- `POST /api/hats/payout-quote` `{hatId, amount, recipient, …}` — dry
  Intents quote (never credits on quote alone)
- `GET /api/mechanisms` + `POST /api/workflows/<id>` —
  `org.simocracy.mechanism`-compatible service

## Cross-chain notes

- Foreign addresses derive via the signer's `derived_public_key` view
  (`{path, predecessor, domain_id}`) — for ed25519 chains the derived key
  IS the base58 foreign address; EVM needs client-side keccak. The bridge
  `/api/hats/:id/foreign` wraps this.
- Chain-signature callbacks are asynchronous — poll `getSig({sigId})`
  until `status` leaves `requested`; request acceptance ≠ signature.
- Intents settlement is only real after solver-confirmed status
  (success/settled/completed) — same discipline as `widespread-solana`.
