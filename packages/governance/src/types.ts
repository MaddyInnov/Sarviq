// SPDX-License-Identifier: Apache-2.0

/** Broad category of what a tool does. Used for policy matching. */
export type ActionClass = 'read' | 'write' | 'execute' | 'network';

/** What the gateway decides for a proposed tool call. */
export type Effect = 'allow' | 'require-approval' | 'deny';

/** A single policy rule. `toolPattern` is compiled as a case-insensitive RegExp
 *  and matched against the tool name. The first matching rule wins. */
export interface PolicyRule {
  id: string;
  toolPattern: string;
  actionClass?: ActionClass;
  effect: Effect;
  reason?: string;
}

/** A deny-by-default policy: `defaultEffect` applies when no rule matches. */
export interface Policy {
  defaultEffect: Effect;
  rules: PolicyRule[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRecord {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  actor: string;
  toolName: string;
  /** Redacted args snapshot — secrets are replaced with '[REDACTED]'. */
  args: Record<string, unknown>;
  status: ApprovalStatus;
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
}

/** Append-only audit entry. `detail` must NEVER contain secrets. */
export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  sessionId?: string;
  action: string;
  toolName?: string;
  decision?: string;
  detail?: string;
}

/** Context of the agent run requesting a tool call. */
export interface EvalContext {
  sessionId: string;
  botId: string;
  actor: string;
}

/** Result of evaluating a proposed tool call against the policy. */
export interface EvaluateResult {
  effect: Effect;
  approvalId?: string;
}
