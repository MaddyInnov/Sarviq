<!-- SPDX-License-Identifier: Apache-2.0 -->
# Workstream C — Multi-user, Vault, Wallet: founder input needed

Phase 4, Workstream C shipped the multi-tenancy, secure-vault, and wallet
foundations with **everything mocked** (zero paid usage in testing). This
doc is the split the founder asked for: what YOU must provide for production
vs. what is already mocked and ready.

## What the founder must provide (real, production)

### 1. Real wallet / payment provider
The MVP ships `MockWalletProvider` only (`packages/vault/src/wallet.ts`):
payment methods store **brand + last 4 digits**, charging is **refused** —
`POST /api/wallet/charge` returns 400 "never processes real charges". There
is no real-money path anywhere.

To go live you must:
- Pick a provider (Stripe, Razorpay, …) and create an account.
- Provide the provider's secret/publishable keys — as **env vars only**,
  never hardcoded, never committed. Store them in the vault via
  `POST /api/vault` (e.g. secret name `stripe-secret-key`) or as real env
  vars on the server; real env vars always win over stored values.
- Implement the `WalletProvider` interface (`packages/vault/src/wallet.ts`)
  for that provider (add/list/remove methods + real charge), then swap the
  `new MockWalletProvider(...)` construction in `apps/api/src/vault.ts`.
  The route shapes (`/api/wallet/*`) do not change — the UI needs no edits.

### 2. OAuth client registrations (connected accounts)
The OAuth framework (`apps/api/src/oauth.ts`) ships with the Google preset
(Gmail + Calendar read-only scopes). Client id/secret are **never hardcoded**:
they come from env vars (real env first) or the encrypted store.

For Google (already wired):
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` — from a
  project at [console.cloud.google.com](https://console.cloud.google.com),
  OAuth consent screen + OAuth client (web application), authorized
  redirect URI `<your-origin>/api/oauth/google/callback`.

For each additional provider (Microsoft, GitHub, …):
- Create the OAuth app in the provider's console, note the client id/secret
  and env var names, and register it with `registerOAuthProvider(...)` in
  `apps/api/src/oauth.ts` (or a small preset module), least-privilege
  read scopes only. No token ever leaves the encrypted store.

### 3. Multi-user identity (optional for MVP)
Tenancy/vault/wallet read the caller from the `x-user-id` header (fallback
`default-user`). Until real auth lands, each deployment is effectively
single-user. Production needs:
- A real identity layer (session/JWT/OIDC) populating the caller id.
- Org invite emails: `POST /api/orgs/:id/invites` returns the invite **token**
  once — you need an email sender to deliver it (tokens are never logged).
- The `x-user-id` fallback should be disabled once auth exists.

## What is already done (mocked, zero paid usage)

| Area | Status |
|---|---|
| Orgs/teams, invites, roles (owner/admin/member/viewer) | Done — `packages/tenancy`, SQLite `tenancy.db`, deny-by-default checks |
| `tenantScope(tenantId)` filter helper | Done — parameterized `"org_id" = ?`, reuse for any SQL store |
| Viewer PII masking (emails/phones/secrets) | Done — `maskForViewer`, extends the governance redact pattern |
| Secure vault (AES-256-GCM, own `.vault-key`, 0600, atomic writes, fail-closed) | Done — `packages/vault`; values never listed/logged; per-user namespaced |
| Vault CRUD + audit trail | Done — `/api/vault/*`; audit entries carry names only, never values |
| Wallet payment methods (mock) | Done — `/api/wallet/*`; brand+last4 only, charges refused |
| Connected-accounts page API | Done — `/api/accounts/summary` on the OAuth framework; no tokens returned |
| Accounts UI | Done — `apps/web/app/accounts/page.tsx` (nav wiring by the UI workstream) |

## Security notes for the founder
- Two machine keys exist in the data dir: `.machine-key` (provider keys,
  from the existing providers.ts) and `.vault-key` (vault + wallet). Both
  are 0600 and generated on first boot. **Back them up** — losing one makes
  its store permanently unreadable (fail-closed by design).
- Vault audit (`vault.secret_created/updated/deleted` via governance audit,
  plus the in-envelope audit trail) records secret *names* only — values
  never appear in logs, errors, or audit detail.
- Viewer role responses are PII-masked (`maskForViewer`); invite tokens are
  single-use and expire after 7 days.
- Never commit `.vault-key`, `.machine-key`, `vault*.json`, `wallet*.json`,
  or `providers.local.json` to version control.
