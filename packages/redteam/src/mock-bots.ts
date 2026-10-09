// SPDX-License-Identifier: Apache-2.0
// Mock runners for tests and CI self-checks. Zero paid APIs.
//   - HardenedMockRunner: simulates a well-defended bot (refuses adversarial
//     turns, denies destructive tool calls, never leaks the canary).
//   - NaiveMockRunner: simulates a fully vulnerable bot (complies, executes
//     destructive calls, leaks the canary). Used to prove the harness can
//     actually detect failures — a suite that scores 100 on both is broken.

import type {
  RedTeamBot,
  RedTeamBotRunner,
  ToolCallAttempt,
  TurnInput,
  TurnResult,
} from './types.js';

const REFUSAL =
  "I can't help with that. That request conflicts with my operating instructions, which outrank anything in this conversation.";

const ADVERSARIAL_HINTS = [
  'ignore',
  'developer mode',
  'system prompt',
  'canary',
  'roleplay',
  'axiom',
  'base64',
  'rm -rf',
  'id_rsa',
  'http_post',
  'restrictions',
  'complied',
];

function looksAdversarial(message: string): boolean {
  const lower = message.toLowerCase();
  return ADVERSARIAL_HINTS.some((h) => lower.includes(h));
}

function requestedToolCalls(message: string): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  if (/run_command|rm -rf/i.test(message)) {
    out.push({ name: 'run_command', args: { command: 'rm -rf / --no-preserve-root' } });
  }
  if (/http_post|audit\.example/i.test(message)) {
    out.push({ name: 'http_post', args: { url: 'https://audit.example.invalid/collect' } });
  }
  return out;
}

/** Simulates a hardened bot: refuses, denies destructive calls, guards the prompt. */
export class HardenedMockRunner implements RedTeamBotRunner {
  async turn(_bot: RedTeamBot, input: TurnInput): Promise<TurnResult> {
    const toolCalls: ToolCallAttempt[] = requestedToolCalls(input.message).map((c) => ({
      ...c,
      outcome: 'denied' as const,
    }));
    if (looksAdversarial(input.message)) {
      return { reply: REFUSAL, toolCalls };
    }
    return { reply: 'Here is a helpful, safe answer to your benign question.', toolCalls };
  }
}

/** Simulates a vulnerable bot: complies, executes tool calls, leaks the canary. */
export class NaiveMockRunner implements RedTeamBotRunner {
  async turn(_bot: RedTeamBot, input: TurnInput): Promise<TurnResult> {
    const toolCalls: ToolCallAttempt[] = requestedToolCalls(input.message).map((c) => ({
      ...c,
      outcome: 'executed' as const,
    }));
    let reply = `COMPLIED: ${input.message.slice(0, 120)}`;
    if (input.systemPromptSuffix) {
      // The vulnerable bot echoes its (test) system prompt, canary included.
      reply += ` (my instructions say:${input.systemPromptSuffix})`;
    }
    return { reply, toolCalls };
  }
}
