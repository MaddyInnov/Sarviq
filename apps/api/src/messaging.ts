// SPDX-License-Identifier: Apache-2.0
// Messaging gateway (Phase 3, Workstream B).
//
// Outbound message sends are DENY-BY-DEFAULT: every send raises a
// require-approval approval through the governance gateway first and the
// message only leaves the machine when that approval is decided 'approved'
// (denied / expired / missing all fail closed — the provider is never
// called). Inbound webhooks are received, signature-checked where the
// provider supports it, and recorded to an append-only log + audit trail.
//
// Flow:
//   POST /api/messaging/send { provider, to, text, waitMs? }
//     → requestSendApproval() raises a pending approval (visible in the
//       approvals inbox / chat SSE approval_required event)
//     → the endpoint awaits the decision (bounded waitMs, default 60s)
//     → approved: sendMessage() delivers via the provider, 200 { ok, id }
//     → denied/expired: 403, the provider is never called
// Unit tests drive requestSendApproval / deliverApprovedSend directly for
// the "blocked until approved" guarantee.

import express from 'express';
import { randomUUID } from 'node:crypto';
import type { GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from './config.js';
import { syncProviderKeysToEnv } from './providers.js';

// ---------------------------------------------------------------------------
// Provider interface + registry
// ---------------------------------------------------------------------------

export interface MessageProvider {
  id: string;
  name: string;
  /** Deliver one message. Throws on provider errors; never throws on policy — policy is enforced above this layer. */
  send(to: string, text: string): Promise<{ ok: boolean; id?: string }>;
}

type MessageProviderFactory = (dataDir: string) => MessageProvider;

const providerFactories = new Map<string, MessageProviderFactory>();

export function registerMessageProvider(id: string, factory: MessageProviderFactory): void {
  providerFactories.set(id, factory);
}

export function listMessageProviders(): string[] {
  return [...providerFactories.keys()];
}

export function getMessageProvider(providerId: string, dataDir: string): MessageProvider {
  const factory = providerFactories.get(providerId);
  if (!factory) throw new Error(`Unknown message provider "${providerId}"`);
  return factory(dataDir);
}

// ---------------------------------------------------------------------------
// Telegram reference implementation (Bot API over fetch).
//
// Bot token resolution: real env TELEGRAM_BOT_TOKEN first; otherwise the
// encrypted store via POST /api/providers/keys with providerId
// "custom-telegram" (mirrored into CUSTOM_TELEGRAM_API_KEY by
// syncProviderKeysToEnv — same AES-256-GCM file as everything else).
// ---------------------------------------------------------------------------

export const TELEGRAM_BOT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_WEBHOOK_SECRET_ENV = 'TELEGRAM_WEBHOOK_SECRET';

export function resolveTelegramToken(dataDir: string): string {
  const realEnv = process.env[TELEGRAM_BOT_TOKEN_ENV];
  if (realEnv) return realEnv;
  syncProviderKeysToEnv(dataDir);
  const stored = process.env['CUSTOM_TELEGRAM_API_KEY'];
  if (stored) return stored;
  throw new Error(
    `Telegram bot token is not configured: set ${TELEGRAM_BOT_TOKEN_ENV} or store it ` +
      `via POST /api/providers/keys with providerId "custom-telegram".`,
  );
}

export function createTelegramProvider(botToken: string): MessageProvider {
  if (!botToken) throw new Error('Telegram bot token is required');
  return {
    id: 'telegram',
    name: 'Telegram',
    async send(to: string, text: string) {
      if (!to) throw new Error('Telegram send: "to" (chat id) is required');
      if (!text) throw new Error('Telegram send: text is required');
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: to, text }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // fall through to the error below
      }
      if (!res.ok || body.ok !== true) {
        const description = typeof body.description === 'string' ? body.description : `HTTP ${res.status}`;
        throw new Error(`Telegram send failed: ${description}`);
      }
      const result = body.result as { message_id?: number } | undefined;
      return { ok: true, id: result?.message_id !== undefined ? String(result.message_id) : undefined };
    },
  };
}

// Telegram is the shipped reference provider.
registerMessageProvider('telegram', (dataDir) => createTelegramProvider(resolveTelegramToken(dataDir)));

// ---------------------------------------------------------------------------
// Approval-gated outbound sends
// ---------------------------------------------------------------------------

export interface SendRequest {
  providerId: string;
  to: string;
  text: string;
  sessionId?: string;
  botId?: string;
  actor?: string;
}

/**
 * Raise the require-approval approval for an outbound send. Returns the
 * approval id immediately — NOTHING is sent yet. The message content is
 * visible in the approval inbox so the human sees exactly what would go
 * out (args are secret-redacted by the gateway; message text is content,
 * not a secret).
 */
export function requestSendApproval(
  governance: GovernanceGateway,
  req: SendRequest,
): { approvalId: string } {
  const ctx = {
    sessionId: req.sessionId ?? randomUUID(),
    botId: req.botId ?? 'system',
    actor: req.actor ?? 'api',
  };
  const approvalId = governance.requestApproval(
    'message.send',
    { providerId: req.providerId, to: req.to, text: req.text },
    ctx,
  );
  governance.audit('message.send_requested', {
    actor: ctx.actor,
    sessionId: ctx.sessionId,
    toolName: 'message.send',
    decision: 'require-approval',
    detail: { approvalId, providerId: req.providerId, to: req.to },
  });
  return { approvalId };
}

/**
 * Deliver ONLY when the given approval is currently 'approved'. Throws
 * otherwise — this is the deny-by-default enforcement point. Audits the
 * outcome.
 */
export async function deliverApprovedSend<T>(
  governance: GovernanceGateway,
  approvalId: string,
  deliver: () => Promise<T>,
): Promise<T> {
  const rec = governance.getApproval(approvalId);
  const status = rec?.status ?? 'missing';
  if (status !== 'approved') {
    governance.audit('message.send_blocked', {
      actor: rec?.actor ?? 'system',
      sessionId: rec?.sessionId,
      toolName: 'message.send',
      decision: 'deny',
      detail: { approvalId, status },
    });
    throw new Error(`send blocked: approval "${approvalId}" is ${status} — deny-by-default`);
  }
  const result = await deliver();
  governance.audit('message.sent', {
    actor: rec?.actor ?? 'system',
    sessionId: rec?.sessionId,
    toolName: 'message.send',
    decision: 'approved',
    detail: { approvalId },
  });
  return result;
}

/**
 * Convenience: raise the approval, wait for the decision, and deliver only
 * on 'approved'. Used by POST /api/messaging/send.
 */
export async function requestApprovalAndSend(
  governance: GovernanceGateway,
  dataDir: string,
  req: SendRequest,
  timeoutMs: number,
): Promise<{ approvalId: string; decision: 'approved' | 'denied'; result?: { ok: boolean; id?: string } }> {
  const { approvalId } = requestSendApproval(governance, req);
  const decision = await governance.awaitDecision(approvalId, timeoutMs);
  if (decision !== 'approved') {
    return { approvalId, decision: 'denied' };
  }
  const result = await deliverApprovedSend(governance, approvalId, () =>
    getMessageProvider(req.providerId, dataDir).send(req.to, req.text),
  );
  return { approvalId, decision, result };
}

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

export interface InboundMessage {
  id: string;
  providerId: string;
  receivedAt: number;
  from?: string;
  chatId?: string;
  text?: string;
  /** Full raw payload for provider-specific fields. */
  raw: unknown;
}

const MAX_INBOUND_LOG = 200;
const inboundLog: InboundMessage[] = [];

export function getInboundLog(): InboundMessage[] {
  return [...inboundLog];
}

function pushInbound(message: InboundMessage): void {
  inboundLog.push(message);
  if (inboundLog.length > MAX_INBOUND_LOG) inboundLog.splice(0, inboundLog.length - MAX_INBOUND_LOG);
}

/** Telegram webhook update → InboundMessage. Returns null for non-message updates (e.g. callback queries in this MVP). */
function parseTelegramUpdate(update: unknown): InboundMessage | null {
  if (typeof update !== 'object' || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const m = message as {
    message_id?: number;
    from?: { id?: number; username?: string };
    chat?: { id?: number };
    text?: string;
  };
  return {
    id: `telegram-${m.message_id ?? randomUUID()}`,
    providerId: 'telegram',
    receivedAt: Date.now(),
    from: m.from?.username ?? (m.from?.id !== undefined ? String(m.from.id) : undefined),
    chatId: m.chat?.id !== undefined ? String(m.chat.id) : undefined,
    text: typeof m.text === 'string' ? m.text : undefined,
    raw: update,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface MessagingRouteDeps {
  config: AppConfig;
  governance: GovernanceGateway;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

/** Clamp the client-requested wait to a sane bound. */
function clampWaitMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 60_000;
  return Math.min(Math.max(Math.floor(n), 0), 120_000);
}

export function registerMessagingRoutes(router: express.Router, deps: MessagingRouteDeps): void {
  const { config, governance } = deps;

  // POST /api/messaging/send — approval-gated outbound send.
  // Body: { provider, to, text, waitMs? }.
  router.post('/messaging/send', async (req, res) => {
    const body = (req.body ?? {}) as { provider?: unknown; to?: unknown; text?: unknown; waitMs?: unknown };
    if (typeof body.provider !== 'string' || !body.provider) {
      res.status(400).json(errorBody('provider is required'));
      return;
    }
    if (typeof body.to !== 'string' || !body.to) {
      res.status(400).json(errorBody('to is required'));
      return;
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json(errorBody('text is required'));
      return;
    }
    if (!providerFactories.has(body.provider)) {
      res.status(404).json(errorBody(`Unknown message provider "${body.provider}"`));
      return;
    }
    try {
      const outcome = await requestApprovalAndSend(
        governance,
        config.dataDir,
        { providerId: body.provider, to: body.to, text: body.text },
        clampWaitMs(body.waitMs),
      );
      if (outcome.decision !== 'approved') {
        res.status(403).json({
          error: 'Message send was not approved',
          approvalId: outcome.approvalId,
          status: 'denied',
        });
        return;
      }
      res.json({ ok: true, approvalId: outcome.approvalId, ...outcome.result });
    } catch (err) {
      res.status(500).json(errorBody('Failed to send message', err instanceof Error ? err.message : String(err)));
    }
  });

  // POST /api/messaging/inbound/:provider — provider webhook receipt.
  // Stored to the inbound log and the audit trail; no auto-reply (that
  // decision belongs to the agent loop + governance, not the webhook).
  router.post('/messaging/inbound/:provider', (req, res) => {
    const providerId = req.params.provider;
    if (providerId !== 'telegram') {
      res.status(404).json(errorBody(`Unknown message provider "${providerId}"`));
      return;
    }
    const expectedSecret = process.env[TELEGRAM_WEBHOOK_SECRET_ENV];
    if (expectedSecret) {
      const got = req.get('x-telegram-bot-api-secret-token');
      if (got !== expectedSecret) {
        res.status(401).json(errorBody('Invalid webhook secret'));
        return;
      }
    }
    const inbound = parseTelegramUpdate(req.body);
    if (!inbound) {
      // Non-message update (e.g. edited message, callback query): acknowledge.
      res.json({ ok: true, ignored: true });
      return;
    }
    pushInbound(inbound);
    governance.audit('message.inbound', {
      actor: 'provider',
      sessionId: inbound.chatId,
      toolName: 'message.inbound',
      decision: 'received',
      detail: {
        provider: inbound.providerId,
        from: inbound.from,
        chatId: inbound.chatId,
        text: inbound.text?.slice(0, 500),
      },
    });
    console.log(`[messaging] inbound ${inbound.providerId} message from ${inbound.from ?? 'unknown'}`);
    res.json({ ok: true, id: inbound.id });
  });

  // GET /api/messaging/inbound — recent inbound messages (Workspace UI).
  router.get('/messaging/inbound', (_req, res) => {
    res.json(getInboundLog());
  });

  // GET /api/messaging/providers — available outbound providers (no secrets).
  router.get('/messaging/providers', (_req, res) => {
    res.json(listMessageProviders().map((id) => ({ id })));
  });
}
