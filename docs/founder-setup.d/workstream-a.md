# Workstream A — Marketplace, Libraries, Billing (Phase 4)

What the founder must provide vs. what is mocked. Short version: **everything
works out of the box with mocks; real money needs real Stripe keys.**

## Mocked (works with zero founder input)

| Area | Status | Notes |
|---|---|---|
| Marketplace registry | Local `packages/marketplace/registry/registry.json` | Curated, bundled with the server. No network. Edit the JSON to add entries. |
| Billing provider | `MockBillingProvider` | Stripe-*shaped* objects (`cus_mock_*`, `in_mock_*`, `pi_mock_*`) but **no network, no real charges**. Invoice lifecycle draft → open → paid, payment intents, voids — all in-memory. |
| Revenue share | Configurable, default 70% creator / 30% platform | `MARKETPLACE_CREATOR_SHARE=0.70` env var. |
| Usage prices | Illustrative list prices, env-overridable | `BILLING_INPUT_PER_1M_CENTS` (30), `BILLING_OUTPUT_PER_1M_CENTS` (60), `BILLING_WORKFLOW_RUN_CENTS` (5), `BILLING_SANDBOX_MINUTE_CENTS` (2). These price *usage for invoices*; they are not provider costs. |

## Founder must provide (to go beyond mocks)

1. **Real Stripe keys** — to accept real money:
   - `STRIPE_SECRET_KEY` (and `STRIPE_PUBLISHABLE_KEY` for any checkout UI).
   - Implement a `StripeBillingProvider implements BillingProvider`
     (`packages/billing/src/provider.ts` defines the interface) and swap it in
     where `registerBillingRoutes` is wired. Keys come from env only — never
     hardcode them, never commit them.
2. **Marketplace curation decision** — the bundled registry is a starter set.
   To sell real entries: add entries to the registry JSON (or build the
   submission/approval flow — not in MVP scope) and set
   `MARKETPLACE_CREATOR_SHARE` to the commercial split.
3. **Payout rails** — the revenue ledger tracks creator balances and records
   payouts, but actually *sending* money (Stripe Connect, bank transfer) is
   out of MVP scope.

## Trust guarantees (unchanged)

- **MCP installs are deny-by-default**: `POST /:id/install` on an MCP entry
  creates a governance approval and writes nothing. The install completes only
  via `POST /:id/install/confirm` with an approval the founder approved in the
  approvals inbox. The installer additionally requires a one-time token —
  defense in depth.
- **Untrusted-output tagging**: third-party registry entries carry
  `untrusted: true`; the UI shows a "third-party" chip.
- **Env secrets are never shipped**: MCP registry entries name *required env
  vars*; the installer writes them as `null` placeholders. Values are entered
  by the founder at runtime.

## API surface (mounted by the integrator)

- `/api/marketplace` — `GET /`, `GET /:id`, `POST /:id/install`,
  `POST /:id/install/confirm`, `GET /revenue/creators`,
  `GET /revenue/creators/:name`, `POST /revenue/usage`
- `/api/billing` — `GET /usage`, `GET /usage/events`, `POST /usage`,
  `GET /usage/cost`, `GET /ledger`, `GET /ledger/:id`, `POST /customers`,
  `GET /customers/:id`, `POST /invoices`, `GET /invoices/:id`,
  `POST /invoices/:id/{finalize,pay,void}`, `POST /payment-intents`,
  `GET /payment-intents/:id`, `POST /payment-intents/:id/{confirm,cancel}`
- Web UI: `/marketplace` page (Browse + Creator revenue tabs).

## Seed libraries

- Bots: 12 (`scout`, `coder`, `helper`, `data-analyst`, `copywriter`,
  `code-reviewer`, `planner`, `translator`, `sql-helper`, `regex-wizard`,
  `meeting-notes`, `learning-tutor`)
- Skills: 32 markdown files in `seed/skills/` (coding, writing, research,
  data, automation)
- Workflows: 5 (`nightly-digest`, `research-note`, `morning-briefing`,
  `code-review-flow`, `weekly-retro`)
