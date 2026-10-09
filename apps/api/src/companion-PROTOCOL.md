<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sarviq Companion App — Server Protocol v1 + Threat Model

Scope: remote control of the user's **own Sarviq PC instance** from the
**Sarviq companion app** on their phone (phone → PC). This is the REVERSE
of remote-phone v1 (`/api/phone/*`, PC → phone); the two namespaces are
independent and share no auth material.

What the app can do: view server health, active runs and pending approvals;
approve/deny tool approvals; pause/resume/cancel chat runs; read the
activity feed and the daily briefing; chat with a bot (same streaming
contract as the web UI); receive live pushes (run status, approvals,
activity hints) over a WebSocket.

## 1. Pairing flow (QR scan)

```
Web UI / API                    Phone app
  |  POST /api/companion/pairing/code  |
  |  (or GET /api/companion/pairing/qr)|
  |  { ott, qrPayload, expiresAt }     |
  |                                    |  user scans QR in the app
  |                                    |  sarviq://pair?host=<lan-ip>&port=<port>&token=<ott>
  |                                    |  POST /api/companion/pairing/exchange
  |                                    |  { ott, deviceName, platform? }
  |  { deviceToken, deviceId }          |
```

- The QR payload is `sarviq://pair?host=<lan-ip>&port=<port>&token=<ott>`
  (`host` = first non-internal IPv4, `port` = the API port).
- The OTT is 128 bits of `crypto.randomBytes` (hex), **single-use**, expires
  in 5 minutes; at most 5 pending OTTs exist at once.
- `exchange` is rate-limited: 10 attempts per IP per 10 minutes → HTTP 429.
- The device token is 256 bits, handed to the phone **once** in the exchange
  response. The server stores only its SHA-256 hash (constant-time compare
  on use). Losing the token means re-pairing (delete + re-scan).
- Pairing proves physical proximity: the QR is displayed on the user's own
  screen and must be scanned within 5 minutes. There is no remote pairing
  path.

## 2. Auth

Every route except `POST /pairing/code`, `GET /pairing/qr` and
`POST /pairing/exchange` requires
`Authorization: Bearer <deviceToken>` → 401 otherwise. Revoking a device
(`DELETE /devices/:id`) drops its live push sockets immediately and its
token stops working at once.

`POST /api/chat` (the web chat endpoint) also accepts the companion Bearer
token — the app may call it directly with the exact body the web UI sends
(`{botId, message, sessionId, queueMode}`) and gets the same SSE stream.
Requests without an `Authorization` header behave exactly as before.

## 3. REST reference (all under `/api/companion`)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/pairing/code` | `{ok, ott, qrPayload, expiresAt}` — no auth |
| GET | `/pairing/qr` | `{ok, qrPayload, expiresAt}` — no auth (UI renders the QR) |
| POST | `/pairing/exchange` | `{ott, deviceName, platform?}` → `{ok, deviceToken, deviceId}` — no auth |
| GET | `/devices` | Paired phones (no token hashes), `online` = live WS |
| DELETE | `/devices/:id` | Revoke; drops WS; audit `companion.unpaired` |
| GET | `/status` | `{ok, server:{name,version}, runs[], activeRuns, pendingApprovals}` |
| GET | `/runs` | Unified run list: `{id, kind, label, state, detail}[]` |
| GET | `/approvals` | Pending approvals (mapped from governance) |
| POST | `/approvals/:id/approve` | `{note?}` → decided record; preference learning + MCP close-the-loop, mirroring `/api/approvals` |
| POST | `/approvals/:id/deny` | Same as approve |
| POST | `/runs/:id/pause` | §4 |
| POST | `/runs/:id/resume` | §4 |
| POST | `/runs/:id/cancel` | §4 |
| POST | `/chat/send` | Thin proxy to the local `/api/chat` SSE endpoint (same stream the web UI gets) |
| GET | `/activity` | `?limit=` — Omni `recent` layer; falls back to the live audit feed |
| GET | `/briefing` | Latest briefing mapped to `{title, body, generatedAt}` (+ raw `payload`); 404 when none exists |

Approval `:id` accepts runtime-issued or real gateway ids (translated via
the governance adapter), same as `/api/approvals/:id`.

## 4. Run controls (honest mapping)

The platform has no generic "pause a run" primitive — the web UI offers
only Stop. The companion exposes what actually exists:

- **Run kinds** in `GET /runs`: `chat-turn` (in-flight turn or companion-
  paused session), `queued-message` (chat queue FIFO), `workflow-run`
  (read-only here).
- **`cancel`**:
  - `chat-turn` → aborts the in-flight turn (exactly the web UI Stop
    button) and clears any pause mark. Audit `companion.run_cancelled`.
  - `queued-message` → dequeues it (`chatQueueStore.remove`).
  - `workflow-run` → 409 `not_supported` (no remote cancel primitive in
    this MVP).
- **`pause`** (chat-turn only): aborts the in-flight turn if any, then marks
  the session paused. While paused, **new turns on that session are rejected
  with 423** (same pattern as paused Spaces); queued messages simply wait.
  Audit `companion.run_paused`.
- **`resume`** (chat-turn only): clears the pause mark; the app can then
  send the next message on the session. Audit `companion.run_resumed`.
- `pause`/`resume` on `queued-message` or `workflow-run` → 409
  `not_supported` with the reason. Runs paused *for approval* resume when
  their approval is decided via the approvals endpoints — that is the
  platform's real resume path.
- Pause marks are in-memory: a server restart clears them (documented
  limitation, same as pending OTTs).

Unknown run id → 404 `run_not_found`.

## 5. Push channel (`/api/companion/ws`)

- Connect: `ws://<host>:<port>/api/companion/ws?token=<deviceToken>`.
  The token is verified **before** the 101 upgrade; invalid/missing → the
  socket is destroyed after a `401` response (never upgraded).
- First message must be `{t:'hello'}` → `{type:'hello', ok:true, deviceId,
  snapshot:{pendingApprovals, activeRuns}}`. `{t:'ping'}` → `{type:'pong'}`.
  Unknown/malformed → `{type:'error', detail}` (socket stays open).
- Server → phone pushes (the app dispatches on `type`):
  - `{type:'run-status', run:{id, workflowId, state}}` — on every workflow
    run update.
  - `{type:'approval', event:'created'|'decided', approval:{...}}` — approval
    lifecycle, wherever it was raised (web chat, workflow, MCP).
  - `{type:'activity', summary}` — hint that something worth refetching
    happened; the app refetches `GET /activity`.
  - `{type:'ping', ts}` — application heartbeat every 30s (in addition to
    WS ping/pong).
- Reconnect-safe: auth is stateless (long-lived token); on reconnect the
  app sends `hello` and gets a fresh snapshot. The app reconnects with
  exponential backoff (1s → 60s cap + jitter).

## 6. Audit

Every remote action is audit-logged (`companion.*` namespace, visible in
the Activity tab): pairing events, WS connect/disconnect/auth failures,
unpair, approval decisions (with `decidedBy: companion:<deviceId>`),
run pause/resume/cancel, chat sends. Chat audits carry metadata only
(device, bot, session, message length) — never message content. Push
payloads are never logged.

## 7. Threat model

| Threat | Mitigation |
|--------|-----------|
| Remote pairing by a stranger | OTT is single-use, 5-min expiry, only obtainable by scanning the QR on the user's own screen; exchange is IP rate-limited. |
| Token theft (network / logs / backups) | Token shown once; server stores SHA-256 hash only, constant-time compare. Raw token never in logs or audit. |
| Stolen token → silent PC control | Same exposure as the web UI itself (which has no login in the MVP). Revoke from Workspace → Devices kills the token and drops live sockets instantly. |
| Brute-forcing OTTs | 128-bit entropy; single-use; max 5 pending; 10 exchange attempts / 10 min / IP. |
| WS hijack without a token | Token verified before the 101 upgrade; failures audit-logged, socket destroyed. |
| A paused session being driven anyway | 423 enforced server-side in the `/api/chat` handler, not just hidden in the app. |
| Approval CSRF / confused deputy | Bearer token required; decision audited with `decidedBy: companion:<deviceId>`; 404/409 guards on already-decided approvals. |
| Push socket resource exhaustion | One lightweight framing implementation (no deps); 16 MB frame cap; heartbeat is unref'd so it never holds the process open. |

### Production expectations (NOT yet implemented)

- **TLS**: the MVP binds LAN without TLS — tokens, approvals and chat
  content travel in cleartext on the local network. Any deployment beyond a
  trusted LAN must terminate TLS (https/wss) first. This is pre-production
  work, same as remote-phone v1.
- The web UI has no login in the MVP — anyone who can reach the API has the
  web UI's powers. The companion token adds a per-device credential on top,
  but it does not make the API itself multi-user safe.
- Push delivery is best-effort: if the socket drops, the app polls
  `/status`, `/approvals`, `/activity` on its own cadence.

## 8. Notes for the Android app workstream

- Chat: the app's `streamChat` currently targets `/chat`; the server exposes
  the endpoint at **`/api/chat`** — call `POST /api/chat` (with the Bearer
  device token) or the namespaced proxy `POST /api/companion/chat/send`.
  Both return the same SSE contract (`token` / `approval_required` / `done`
  / `error` events, `: ping` heartbeats; JSON `{ok, queued}` when a turn is
  in-flight with `queueMode: 'queue'`).
- `GET /api/companion/runs` exists (the app already calls it) in addition
  to the `runs` array inside `GET /status`.
- `exchangePairing` returns `{deviceToken, deviceId}` — the app also
  accepts a bare `token` field, but `deviceToken` is canonical.
- There is no conversation-history endpoint yet; the app should keep its
  own local chat history (the platform stores sessions internally without
  a clean REST read path).
