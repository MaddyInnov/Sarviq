// SPDX-License-Identifier: Apache-2.0
// Shared DTO / wire types for the API layer. Package-owned domain types
// (BotConfig, StreamEvent, ApprovalRecord, AuditEntry, WorkflowDefinition,
// WorkflowRun) are imported from the workspace packages; these are the
// HTTP-facing shapes built on top of them.

import type { ApprovalRecord, AuditEntry } from '@mvp/governance';
import type { ModelInfo, RateLimitSnapshot, StreamEvent } from '@mvp/agent-runtime';
import type { WorkflowDefinition, WorkflowRun } from '@mvp/workflows';

export interface ChatRequestBody {
  botId: string;
  message: string;
  sessionId?: string;
  provider?: string;
  model?: string;
}

export interface DecideApprovalBody {
  decision: 'approved' | 'denied';
  note?: string;
}

export interface ProviderKeyBody {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface ProviderInfo {
  id: string;
  name: string;
  api: string;
  configured: boolean;
  models: ModelInfo[];
  /** Latest rate-limit/quota snapshot captured from response headers (null when unknown). */
  rateLimit: RateLimitSnapshot | null;
  /**
   * Subscription/CLI bridge (MausBot parity): 'claude' | 'codex'. Set only on
   * bridge presets (claude-subscription / codex-subscription).
   */
  bridge?: 'claude' | 'codex';
  /** Bridge only: a matching CLI or credential file was detected on this machine. */
  detected?: boolean;
  /** Bridge only: the user granted Connect consent (token readable in memory). */
  connected?: boolean;
}

export interface RunWorkflowBody {
  input?: unknown;
  idempotencyKey?: string;
}

export interface DryRunBody {
  botId: string;
  message: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

// Re-exports so route handlers have a single import surface.
export type { ApprovalRecord, AuditEntry, ModelInfo, RateLimitSnapshot, StreamEvent, WorkflowDefinition, WorkflowRun };
