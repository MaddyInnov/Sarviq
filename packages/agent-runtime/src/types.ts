// SPDX-License-Identifier: Apache-2.0

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
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

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; call: ToolCall; approvalRequired: boolean; approvalId?: string }
  | { type: 'tool_result'; call: ToolCall; result: unknown; denied?: boolean }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; message: string }
  | { type: 'approval_required'; approvalId: string; call: ToolCall };

export interface ToolContext {
  sessionId: string;
  botId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * One per-bot governance rule. Same first-match-wins semantics as the
 * governance package's PolicyRule: `toolPattern` is compiled as a
 * case-insensitive RegExp and matched against the tool name.
 */
export interface BotPolicyRule {
  id: string;
  toolPattern: string;
  effect: 'allow' | 'deny' | 'require-approval';
  reason?: string;
}

/**
 * Per-bot governance policy. When present, its rules are PREPENDED to the
 * global policy before evaluation (first match wins), so bot rules can
 * tighten OR loosen the global floor for that bot only. Absent → the global
 * policy applies unchanged.
 */
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

export interface LLMProvider {
  readonly providerId: string;
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void; signal?: AbortSignal },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }>;
  listModels(): Promise<ModelInfo[]>;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  /** True when the model is free to call (catalog free:true / ':free' / '-free' suffix). */
  free?: boolean;
}

/**
 * Internal extension: the runtime tracks which tool calls an assistant message
 * produced so history can be re-serialized for providers (OpenAI tool_calls,
 * Anthropic tool_use blocks). The public ChatMessage contract is unchanged;
 * SessionStore persists this in a dedicated column.
 */
export type RichMessage = ChatMessage & { toolCalls?: ToolCall[] };

export function getMessageToolCalls(msg: ChatMessage): ToolCall[] | undefined {
  return (msg as RichMessage).toolCalls;
}

export function withToolCalls(msg: ChatMessage, toolCalls: ToolCall[]): RichMessage {
  return { ...msg, toolCalls };
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
