// SPDX-License-Identifier: Apache-2.0
// Production runner: drives a real bot through AgentRuntime.runTurn and
// observes the stream events. This is the natural seam — the harness never
// touches providers directly.
//
// - Bot replies are reconstructed from `token` events.
// - Tool calls are observed via `tool_call` events; their outcome comes from
//   `tool_result` (denied flag) and `approval_required` events.
// - Indirect-injection attacks: simulated tool outputs are wrapped with the
//   runtime's own untrusted-data tags (tagUntrustedToolOutput) and delivered
//   as part of the message, exactly as compromised tool output would appear.

import {
  tagUntrustedToolOutput,
  type AgentRuntime,
  type BotConfig,
  type StreamEvent,
} from '@mvp/agent-runtime';
import type {
  RedTeamBot,
  RedTeamBotRunner,
  ToolCallAttempt,
  ToolCallOutcome,
  TurnInput,
  TurnResult,
} from './types.js';

export interface AgentRuntimeRunnerOptions {
  /** Cap on tool-iteration loops per turn (safety; default 3). */
  maxIterations?: number;
  /**
   * How long a turn waits for a human approval decision before failing
   * closed (ms; default 1500). Destructive-but-not-catastrophic calls mint
   * an approval card; the red-team run must not hang on a human that will
   * never answer, so this stays short. Timed-out calls are recorded as
   * denied.
   */
  approvalTimeoutMs?: number;
}

export class AgentRuntimeRunner implements RedTeamBotRunner {
  private readonly runtime: AgentRuntime;
  private readonly botConfig: BotConfig;
  private readonly maxIterations: number;
  private readonly approvalTimeoutMs: number;

  constructor(runtime: AgentRuntime, botConfig: BotConfig, opts: AgentRuntimeRunnerOptions = {}) {
    this.runtime = runtime;
    this.botConfig = botConfig;
    this.maxIterations = opts.maxIterations ?? 3;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 1500;
  }

  async turn(bot: RedTeamBot, input: TurnInput): Promise<TurnResult> {
    let message = input.message;
    if (input.simulatedToolOutputs?.length) {
      const blocks = input.simulatedToolOutputs
        .map((o) => tagUntrustedToolOutput(o.toolName, o.content))
        .join('\n\n');
      message = `${message}\n\n[Simulated tool output — red-team test fixture]\n${blocks}`;
    }

    const replyParts: string[] = [];
    const calls = new Map<string, { name: string; args: Record<string, unknown>; outcome: ToolCallOutcome }>();

    const onEvent = async (e: StreamEvent): Promise<void> => {
      switch (e.type) {
        case 'token':
          replyParts.push(e.content);
          break;
        case 'tool_call':
          calls.set(e.call.id, { name: e.call.name, args: e.call.args, outcome: 'executed' });
          break;
        case 'approval_required': {
          const c = calls.get(e.call.id);
          if (c) c.outcome = 'approval-required';
          else calls.set(e.call.id, { name: e.call.name, args: e.call.args, outcome: 'approval-required' });
          break;
        }
        case 'tool_result': {
          const c = calls.get(e.call.id);
          if (c && e.denied === true) c.outcome = 'denied';
          break;
        }
        default:
          break;
      }
    };

    const botWithSuffix: BotConfig =
      input.systemPromptSuffix !== undefined
        ? { ...this.botConfig, systemPrompt: `${this.botConfig.systemPrompt}${input.systemPromptSuffix}` }
        : this.botConfig;

    await this.runtime.runTurn({
      bot: botWithSuffix,
      sessionId: input.sessionId,
      message,
      maxIterations: this.maxIterations,
      approvalTimeoutMs: this.approvalTimeoutMs,
      onEvent,
    });

    return {
      reply: replyParts.join(''),
      toolCalls: [...calls.values()].map((c) => ({ name: c.name, args: c.args, outcome: c.outcome })),
    };
  }
}
