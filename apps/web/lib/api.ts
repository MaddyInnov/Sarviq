// SPDX-License-Identifier: Apache-2.0
// Typed client for the MVP API. ALL API calls go through getApiBase() so one
// frontend codebase works in three contexts:
//  - Tauri desktop: window.__TAURI__ is present → http://127.0.0.1:4567
//    (the sidecar API; CORS allows any origin in the MVP)
//  - Local dev: NEXT_PUBLIC_API_URL (e.g. http://localhost:4000)
//  - Docker/server: '' → same-origin (the API serves the frontend)

export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __TAURI__?: unknown };
    if (w.__TAURI__) return 'http://127.0.0.1:4567';
  }
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.length > 0) return env;
  return '';
}

// ---- Shared types (mirror the API wire shapes) ----------------------------

export type BotPolicyEffect = 'allow' | 'deny' | 'require-approval';

export interface BotPolicyRule {
  id: string;
  toolPattern: string;
  effect: BotPolicyEffect;
  reason?: string;
}

export interface BotPolicy {
  rules: BotPolicyRule[];
}

export interface BotConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: string;
  model: string;
  skills: string[];
  tools: string[];
  mcpServers: string[];
  policy?: BotPolicy;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RateLimitSnapshot {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  resetAt?: string;
}

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; call: ToolCall; approvalRequired: boolean; approvalId?: string }
  | { type: 'tool_result'; call: ToolCall; result: unknown; denied?: boolean }
  | { type: 'done'; usage: TokenUsage | null }
  | { type: 'error'; message: string }
  | { type: 'interrupted'; reason: string }
  | { type: 'approval_required'; approvalId: string; call: ToolCall }
  /**
   * Rich inline card. `widget` is validated client-side against the widget
   * schema (components/widgets) — invalid payloads render as an error block,
   * never raw.
   */
  | { type: 'widget'; widget: unknown };

export interface ApprovalRecord {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  actor: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
}

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

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  /** True when the model is free to call (catalog free:true / :free / -free suffix). */
  free?: boolean;
}

/**
 * Flat model catalog entry from GET /api/models. Prices are PUBLIC
 * LIST-PRICE ESTIMATES, not live billing — see the API's pricing.ts.
 */
export interface ModelPriceInfo {
  providerId: string;
  id: string;
  name: string;
  contextLength?: number;
  free: boolean;
  inputPer1M?: number;
  outputPer1M?: number;
  estimated: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  api: string;
  configured: boolean;
  models: ModelInfo[];
  /** Latest rate-limit/quota snapshot from response headers (null when unknown). */
  rateLimit: RateLimitSnapshot | null;
  /** Subscription/CLI bridge: 'claude' | 'codex'. Set only on bridge presets. */
  bridge?: 'claude' | 'codex';
  /** Bridge only: a matching CLI or credential file was detected on this machine. */
  detected?: boolean;
  /** Bridge only: Connect consent granted (token readable in memory). */
  connected?: boolean;
}

export interface WorkflowNodeDef {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNodeDef[];
  edges: [string, string][];
}

export interface NodeState {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'paused' | 'skipped';
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  approvalId?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: 'running' | 'paused' | 'succeeded' | 'failed';
  nodeStates: Record<string, NodeState>;
  input: unknown;
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PreviewResult {
  verdict: 'ready' | 'warning' | 'blocked';
  bot: string;
  provider: string;
  model: string;
  keyConfigured: boolean;
  skills: string[];
  tools: Array<{ name: string; effect: string }>;
  mcpServers: string[];
  nextActions: string[];
}

// ---- Fetch helpers ----------------------------------------------------------

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${getApiBase()}${path}`, init);
  return res;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

export const getBots = (): Promise<BotConfig[]> => apiJson('/api/bots');
export const getProviders = (): Promise<ProviderInfo[]> => apiJson('/api/providers');
export const getModels = (freeOnly = false): Promise<ModelPriceInfo[]> =>
  apiJson(`/api/models${freeOnly ? '?freeOnly=1' : ''}`);
export function updateBotPolicy(botId: string, rules: BotPolicyRule[]): Promise<{ ok: boolean; botId: string; policy: BotPolicy }> {
  return apiJson(`/api/bots/${encodeURIComponent(botId)}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}

export function getApprovals(status?: string): Promise<ApprovalRecord[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiJson(`/api/approvals${q}`);
}

export function decideApproval(
  id: string,
  decision: 'approved' | 'denied',
  note?: string,
): Promise<ApprovalRecord> {
  return apiJson(`/api/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, note }),
  });
}

/**
 * "Always allow this tool" — appends a persistent allow rule for one tool
 * to the bot's governance policy so future calls skip the approval card.
 */
export function allowTool(
  botId: string,
  tool: string,
): Promise<{ ok: boolean; botId: string; tool: string }> {
  return apiJson(`/api/bots/${encodeURIComponent(botId)}/allow-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool }),
  });
}

// ---- Custom slash commands --------------------------------------------------

export interface SlashCommand {
  description: string;
  prompt: string;
}

export function getSlashCommands(): Promise<{ ok: boolean; commands: Record<string, SlashCommand> }> {
  return apiJson('/api/slash-commands');
}

export function saveSlashCommand(
  name: string,
  command: SlashCommand,
): Promise<{ ok: boolean; commands: Record<string, SlashCommand> }> {
  return apiJson('/api/slash-commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...command }),
  });
}

export function deleteSlashCommand(name: string): Promise<{ ok: boolean; deleted: string }> {
  return apiJson(`/api/slash-commands/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function getAudit(limit = 100): Promise<AuditEntry[]> {
  return apiJson(`/api/audit?limit=${limit}`);
}

// ---- Collaborative Pages ----------------------------------------------------

export interface Page {
  id: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface PageVersion {
  id: string;
  pageId: string;
  version: number;
  title: string;
  content: string;
  createdAt: number;
  createdBy: string;
}

export interface PageComment {
  id: string;
  pageId: string;
  author: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}

export interface PageMention {
  id: string;
  pageId: string;
  mentioned: string;
  isBot: boolean;
  context: string;
  author: string;
  status: 'pending' | 'done' | 'failed';
  createdAt: number;
}

export interface PageDetail extends Page {
  comments: PageComment[];
  mentions: PageMention[];
}

export const listPages = (): Promise<Page[]> => apiJson('/api/pages');

export function createPage(input: { title: string; content?: string; createdBy?: string }): Promise<Page> {
  return apiJson('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export const getPage = (id: string): Promise<PageDetail> =>
  apiJson(`/api/pages/${encodeURIComponent(id)}`);

export function updatePage(
  id: string,
  input: { title?: string; content?: string; updatedBy?: string },
): Promise<Page> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deletePage(id: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export const listPageVersions = (id: string): Promise<PageVersion[]> =>
  apiJson(`/api/pages/${encodeURIComponent(id)}/versions`);

export function restorePageVersion(id: string, versionId: string): Promise<Page> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/restore/${encodeURIComponent(versionId)}`, {
    method: 'POST',
  });
}

export function addPageComment(
  id: string,
  input: { author: string; text: string },
): Promise<PageComment> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function resolvePageComment(
  id: string,
  commentId: string,
  resolved: boolean,
): Promise<PageComment> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  });
}

export function deletePageComment(id: string, commentId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
}

export function addPageMention(
  id: string,
  input: { mentioned: string; context?: string; author?: string },
): Promise<PageMention> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/mentions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function saveProviderKey(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
  headers?: Record<string, string>,
): Promise<{ ok: boolean }> {
  return apiJson('/api/providers/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey, baseUrl, headers }),
  });
}

export function removeProviderKey(providerId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/providers/keys/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
}

export function connectBridge(bridgeId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/providers/bridges/${encodeURIComponent(bridgeId)}/connect`, {
    method: 'POST',
  });
}

export function disconnectBridge(bridgeId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/providers/bridges/${encodeURIComponent(bridgeId)}/disconnect`, {
    method: 'DELETE',
  });
}

export const getWorkflows = (): Promise<WorkflowDefinition[]> => apiJson('/api/workflows');

export function runWorkflow(
  id: string,
  input?: unknown,
  idempotencyKey?: string,
): Promise<{ runId: string }> {
  return apiJson(`/api/workflows/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, idempotencyKey }),
  });
}

export const getRuns = (): Promise<WorkflowRun[]> => apiJson('/api/workflows/runs');
export const getRun = (runId: string): Promise<WorkflowRun> =>
  apiJson(`/api/workflows/runs/${encodeURIComponent(runId)}`);

export function dryRun(botId: string, message: string): Promise<PreviewResult> {
  return apiJson('/api/dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId, message }),
  });
}

// ---- SSE --------------------------------------------------------------------

export interface ChatRequest {
  botId: string;
  message: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** Sandbox mode: read-only | workspace-write | danger-full-access. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Session auto-approve: skip approval cards for this turn (audited). */
  autoApprove?: boolean;
  /** Plan mode: read-only exploration, mutating tools denied. */
  planMode?: boolean;
  /** Fail-closed max spend in USD for this turn. */
  maxBudgetUsd?: number;
  /** AbortSignal to cancel the stream client-side (Stop button). */
  signal?: AbortSignal;
}

/** POST /api/chat and yield each SSE `data:` payload as a parsed StreamEvent. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const { signal, ...body } = req;
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`Chat failed (${res.status}): ${detail || res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          yield JSON.parse(line.slice('data: '.length)) as StreamEvent;
        }
      }
    }
  }
}

/** SSE of workflow run updates for one run. */
export async function* streamRunUpdates(runId: string): AsyncGenerator<WorkflowRun> {
  const res = await apiFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/stream`);
  if (!res.ok || !res.body) throw new Error(`Run stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          yield JSON.parse(line.slice('data: '.length)) as WorkflowRun;
        }
      }
    }
  }
}
