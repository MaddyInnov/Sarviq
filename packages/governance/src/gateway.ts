// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';
// NOTE: `node:sqlite` is loaded at runtime via process.getBuiltinModule
// instead of a top-level `import ... from 'node:sqlite'` because this repo's
// vitest (Vite 5.4.21) cannot statically resolve that specifier
// ("Failed to load url sqlite"). The cast keeps full typing.
const { DatabaseSync } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');
type Database = InstanceType<typeof DatabaseSync>;
import { DENYLIST_COMMAND_RE } from './default-policy.js';
import type {
  ActionClass,
  ApprovalRecord,
  ApprovalStatus,
  AuditEntry,
  Effect,
  EvalContext,
  EvaluateResult,
  Policy,
  PolicyRule,
} from './types.js';

/** Default approval timeout when neither the constructor nor awaitDecision sets one. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface GatewayOptions {
  /** SQLite file path, or ':memory:' for an ephemeral database. */
  dbPath: string;
  policy: Policy;
  /** Fallback timeout for awaitDecision(). */
  approvalTimeoutMs?: number;
}

export type PreHook = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: EvalContext,
) => Promise<void> | void;

export type PostHook = (
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: EvalContext,
) => Promise<void> | void;

interface Waiter {
  resolve: (decision: 'approved' | 'denied') => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Raw DB row shape for the approvals table. */
interface ApprovalRow {
  id: string;
  ts: number;
  session_id: string;
  bot_id: string;
  actor: string;
  tool_name: string;
  args_json: string;
  status: ApprovalStatus;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
}

/** Raw DB row shape for the audit_log table. */
interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  session_id: string | null;
  action: string;
  tool_name: string | null;
  decision: string | null;
  detail: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  tool_name TEXT,
  decision TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`;

/**
 * Deny-by-default action gateway.
 *
 * Every proposed tool call is classified, matched against the policy (first
 * rule wins, else defaultEffect), and resolved to allow / require-approval /
 * deny. Approvals are persisted in SQLite; audit entries are append-only and
 * secret-redacted.
 */
export class GovernanceGateway {
  private static readonly READ_TOOLS = new Set([
    'read_file',
    'web_search',
    'web_fetch',
    'list_dir',
  ]);
  private static readonly WRITE_TOOLS = new Set([
    'write_file',
    'edit_file',
    'create_file',
    'delete_file',
    'remove_file',
  ]);
  private static readonly EXECUTE_TOOLS = new Set([
    'run_command',
    'exec',
    'shell',
  ]);

  private readonly db: Database;
  private readonly policy: Policy;
  private readonly approvalTimeoutMs: number;
  private readonly waiters = new Map<string, Waiter>();
  private readonly preHooks: PreHook[] = [];
  private readonly postHooks: PostHook[] = [];

  constructor(options: GatewayOptions) {
    this.policy = options.policy;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(SCHEMA);
  }

  /** Release the SQLite connection. */
  close(): void {
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
    }
    this.waiters.clear();
    this.db.close();
  }

  /**
   * Classify a tool into a broad action class. Unknown tools are treated as
   * 'write' (conservative) so they never auto-run under the default policy.
   */
  classify(toolName: string): ActionClass {
    const name = toolName.trim();
    if (GovernanceGateway.READ_TOOLS.has(name)) return 'read';
    if (GovernanceGateway.WRITE_TOOLS.has(name)) return 'write';
    if (GovernanceGateway.EXECUTE_TOOLS.has(name)) return 'execute';
    if (name.startsWith('mcp:') || name.startsWith('http')) return 'network';
    return 'write';
  }

  /**
   * Evaluate a proposed tool call. First matching rule wins; otherwise the
   * policy defaultEffect applies. 'require-approval' creates a pending
   * approval record and returns its id. 'deny' (including denylist hits) is
   * audited.
   */
  async evaluate(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
  ): Promise<EvaluateResult> {
    const actionClass = this.classify(toolName);

    // Hard denylist on run_command args — unconditional deny, no rule needed.
    const command = args['command'];
    if (typeof command === 'string' && DENYLIST_COMMAND_RE.test(command)) {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'deny',
        detail: {
          reason: 'denylist: destructive command pattern',
          actionClass,
          args: redactSecrets(args),
        },
      });
      return { effect: 'deny' };
    }

    const rule = this.policy.rules.find((r) => this.ruleMatches(r, toolName, actionClass));
    const effect: Effect = rule?.effect ?? this.policy.defaultEffect;

    if (effect === 'allow') {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'allow',
        detail: { reason: rule?.reason ?? 'default policy', ruleId: rule?.id },
      });
      return { effect };
    }

    if (effect === 'deny') {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'deny',
        detail: {
          reason: rule?.reason ?? 'default policy',
          ruleId: rule?.id,
          args: redactSecrets(args),
        },
      });
      return { effect };
    }

    // require-approval: persist a pending approval with a redacted args snapshot.
    const approvalId = this.requestApproval(toolName, args, ctx);
    this.audit('approval.created', {
      actor: ctx.actor,
      sessionId: ctx.sessionId,
      toolName,
      decision: 'require-approval',
      detail: { approvalId, args: redactSecrets(args) },
    });
    return { effect, approvalId };
  }

  /**
   * Create a standalone approval request (e.g. for workflow approval nodes
   * or any human-in-the-loop step that is not a tool call). Returns the
   * approval id; the caller typically follows with awaitDecision().
   */
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
  ): string {
    const record: ApprovalRecord = {
      id: randomUUID(),
      ts: Date.now(),
      sessionId: ctx.sessionId,
      botId: ctx.botId,
      actor: ctx.actor,
      toolName,
      args: redactSecrets(args),
      status: 'pending',
    };
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, ts, session_id, bot_id, actor, tool_name, args_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.ts,
        record.sessionId,
        record.botId,
        record.actor,
        record.toolName,
        JSON.stringify(record.args),
        record.status,
      );
    return record.id;
  }

  /**
   * Wait until an approval is decided. Resolves 'approved' or 'denied'.
   * On timeout the approval is marked 'expired' and the promise resolves
   * 'denied' (fail closed).
   */
  async awaitDecision(
    approvalId: string,
    timeoutMs?: number,
  ): Promise<'approved' | 'denied'> {
    const rec = this.getApproval(approvalId);
    if (!rec) {
      throw new Error(`approval not found: ${approvalId}`);
    }
    if (rec.status === 'approved') return 'approved';
    if (rec.status === 'denied' || rec.status === 'expired') return 'denied';

    const timeout = timeoutMs ?? this.approvalTimeoutMs;
    return new Promise<'approved' | 'denied'>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        this.markExpired(approvalId);
        this.audit('approval.expired', {
          actor: rec.actor,
          sessionId: rec.sessionId,
          toolName: rec.toolName,
          decision: 'expired',
          detail: { approvalId },
        });
        resolve('denied');
      }, timeout);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiters.set(approvalId, { resolve, timer });
    });
  }

  /**
   * Record a human decision on a pending approval. Throws if the approval
   * does not exist or is no longer pending. Resolves any in-flight
   * awaitDecision() waiter and appends an audit entry.
   */
  decide(
    approvalId: string,
    decision: 'approved' | 'denied',
    opts: { decidedBy?: string; note?: string } = {},
  ): ApprovalRecord {
    const rec = this.getApproval(approvalId);
    if (!rec) {
      throw new Error(`approval not found: ${approvalId}`);
    }
    if (rec.status !== 'pending') {
      throw new Error(`approval ${approvalId} is ${rec.status}, not pending`);
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE approvals
         SET status = ?, decided_at = ?, decided_by = ?, note = ?
         WHERE id = ?`,
      )
      .run(decision, now, opts.decidedBy ?? null, opts.note ?? null, approvalId);

    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(approvalId);
      waiter.resolve(decision);
    }

    this.audit('approval.decided', {
      actor: opts.decidedBy ?? rec.actor,
      sessionId: rec.sessionId,
      toolName: rec.toolName,
      decision,
      detail: { approvalId, note: opts.note },
    });

    const updated = this.getApproval(approvalId);
    if (!updated) {
      throw new Error(`approval vanished after decision: ${approvalId}`);
    }
    return updated;
  }

  /** List approvals, newest first, optionally filtered by status. */
  listApprovals(status?: ApprovalStatus): ApprovalRecord[] {
    const stmt = status
      ? this.db.prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY ts DESC`)
      : this.db.prepare(`SELECT * FROM approvals ORDER BY ts DESC`);
    const rows = (status ? stmt.all(status) : stmt.all()) as unknown as ApprovalRow[];
    return rows.map(GovernanceGateway.rowToRecord);
  }

  /** Fetch a single approval by id. */
  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .get(id) as unknown as ApprovalRow | undefined;
    return row ? GovernanceGateway.rowToRecord(row) : undefined;
  }

  /**
   * Append an audit entry. `detail` is secret-redacted and JSON-stringified
   * before storage, so API keys and tokens never reach the audit log.
   */
  audit(
    action: string,
    fields: {
      actor?: string;
      sessionId?: string;
      toolName?: string;
      decision?: string;
      detail?: unknown;
    } = {},
  ): void {
    let detailJson: string | null = null;
    if (fields.detail !== undefined) {
      const redacted = redactSecrets(fields.detail);
      try {
        detailJson = JSON.stringify(redacted);
      } catch {
        detailJson = JSON.stringify({ note: '[unserializable detail]' });
      }
    }
    this.db
      .prepare(
        `INSERT INTO audit_log
           (ts, actor, session_id, action, tool_name, decision, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        fields.actor ?? 'system',
        fields.sessionId ?? null,
        action,
        fields.toolName ?? null,
        fields.decision ?? null,
        detailJson,
      );
  }

  /** Append-only audit log, newest first. */
  listAudit(limit = 100, offset = 0): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      sessionId: row.session_id ?? undefined,
      action: row.action,
      toolName: row.tool_name ?? undefined,
      decision: row.decision ?? undefined,
      detail: row.detail ?? undefined,
    }));
  }

  /** Register a pre-tool-execution hook (runs before the tool call). */
  addPreHook(fn: PreHook): void {
    this.preHooks.push(fn);
  }

  /** Register a post-tool-execution hook (runs after the tool call). */
  addPostHook(fn: PostHook): void {
    this.postHooks.push(fn);
  }

  /** Run pre-hooks in registration order; invoked by the agent runtime. */
  async runPreHooks(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
  ): Promise<void> {
    for (const fn of this.preHooks) {
      await fn(toolName, args, ctx);
    }
  }

  /** Run post-hooks in registration order; invoked by the agent runtime. */
  async runPostHooks(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    ctx: EvalContext,
  ): Promise<void> {
    for (const fn of this.postHooks) {
      await fn(toolName, args, result, ctx);
    }
  }

  private ruleMatches(
    rule: PolicyRule,
    toolName: string,
    actionClass: ActionClass,
  ): boolean {
    if (rule.actionClass !== undefined && rule.actionClass !== actionClass) {
      return false;
    }
    let re: RegExp;
    try {
      // Case-insensitive per the denylist naming convention (/delete|remove|drop|exec/i).
      re = new RegExp(rule.toolPattern, 'i');
    } catch {
      return false; // Invalid pattern: fail closed (no match).
    }
    return re.test(toolName);
  }

  private markExpired(approvalId: string): void {
    this.db
      .prepare(`UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`)
      .run(approvalId);
  }

  private static rowToRecord(row: ApprovalRow): ApprovalRecord {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.args_json);
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt args_json: keep empty rather than crashing the gateway.
    }
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      botId: row.bot_id,
      actor: row.actor,
      toolName: row.tool_name,
      args,
      status: row.status,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      note: row.note ?? undefined,
    };
  }
}
