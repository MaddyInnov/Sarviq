# Governance + Data batch — REST API reference

Backend for 4 Laya-inspired features (processing rules, MCP tool scopes,
privacy tiers, cost dashboard). All routes are under `/api`. Money is
integer USD cents. Timestamps are ms epoch.

## Processing rules + firing log

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/processing-rules` | — | `ProcessingRule[]` |
| POST | `/processing-rules` | `{ name, match?, actions, enabled? }` | `201 ProcessingRule` |
| GET | `/processing-rules/firing-log` | `?ruleId=&status=success\|error\|skipped&since=&until=&limit=` | `FiringLogEntry[]` (newest first) |
| GET | `/processing-rules/:id` | — | `ProcessingRule` |
| PATCH | `/processing-rules/:id` | `{ name?, match?, actions?, enabled? }` | `ProcessingRule` |
| DELETE | `/processing-rules/:id` | — | `{ ok: true }` |
| POST | `/processing-rules/:id/fire` | `{ item: { id, kind, source?, text?, meta? }, actor? }` | `FiringReport` |

- `match`: `{ textPattern?, kind?, source? }` — all specified fields must match (AND); `textPattern` is a case-insensitive regex on the item text.
- `actions`: array of `{ type: 'tag'|'route'|'run-agent'|'egress', params }`. Required params: `tag`→`{tag}`, `route`→`{destination}`, `run-agent`→`{agentId}`, `egress`→`{target}`.
- `FiringReport`: `{ itemId, matchedRuleIds, firings: FiringLogEntry[] }`.
- `FiringLogEntry`: `{ id, ts, ruleId, ruleName, itemId, itemKind, action, status: 'success'|'error'|'skipped', reason?, detail? }`.

## MCP tool scopes

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/mcp/tools` | — | `[{ id, name, description, requiredScope: 'read'\|'write'\|'egress', scopes: { read, write, egress } }]` |
| PATCH | `/mcp/tools/:id/scopes` | `{ read?, write?, egress? }` (≥1 required) | updated entry |

- Each tool has one **required** scope (derived from its nature: `mcp:*`/`http*`/`send_*`/`webhook`/`fetch_*`/`chat` → `egress`; file/memory/shell mutations → `write`; else `read`).
- A call whose required scope toggle is OFF is denied in the MCP `tools/call` path with `{ status: 'denied', code: 'scope_denied', requiredScope, message }` — before governance evaluation.
- Toggles persist in `<dataDir>/mcp-scopes.db`; unset tools default to all-ON.

## Privacy tiers

Tiers: `metadata` (facts about data — usable anywhere) / `cloud-ok` (may go to cloud providers; default for conversational data) / `local-only` (must never leave the machine).

- Vault secrets carry `tier` (default `local-only`): `POST /vault` and `PUT /vault/:name` accept an optional `tier` field; `GET /vault` and `GET /vault/:name` return it.
- Memory atoms/events carry `tier` (default `cloud-ok`); prompt recall excludes `local-only` by default.
- Any cloud egress containing a `local-only` item is denied fail-closed with a `privacy.egress_denied` audit entry (ids/tiers only, never contents).

## Cost dashboard (under `/api/billing`)

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/usage/breakdown` | `?period=day\|week\|month\|all&feature=&since=&until=` | `{ period, since, until, byFeature[], byStep[], totals }` |
| POST | `/usage/cost-events` | `{ feature, step, model?, inputTokens, outputTokens, costCents?, sessionId?, botId? }` | `201 CostEvent` |
| GET | `/usage/caps` | — | `FeatureCapStatus[]` |
| PUT | `/usage/caps/:feature` | `{ monthlyCapCents }` | `FeatureCapStatus` |

- `byFeature[]`: `{ feature, events, inputTokens, outputTokens, costCents }` (cost desc).
- `byStep[]`: `{ step, feature, events, inputTokens, outputTokens, costCents }`.
- `FeatureCapStatus`: `{ feature, capCents|null, spentCents, capExceeded, periodStart, periodEnd }` — `capExceeded` is the dashboard signal (true only when a cap is set and monthly spend exceeds it).
- When `costCents` is omitted on record, it is estimated from tokens via the `BILLING_*` price env (same defaults as `pricing.ts`).
