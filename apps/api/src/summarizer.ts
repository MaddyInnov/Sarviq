// SPDX-License-Identifier: Apache-2.0
// Default summarizer for the session store's auto-compaction hook.
//
// Strategy: try a cheap model first (Groq's free tier is the platform's
// default free substrate), capped input so summarization itself stays cheap.
// If no provider/key is available — or the call fails — fall back to an
// honest extractive summary (first/last messages + counts) so compaction
// NEVER breaks a session for lack of a key. The fallback is clearly labeled.

import { createProvider } from '@mvp/agent-runtime';
import type { ChatMessage } from '@mvp/agent-runtime';

const MAX_INPUT_CHARS = 24_000;

function renderMessage(m: ChatMessage): string {
  const content = typeof m.content === 'string' ? m.content : '[non-text content]';
  const toolNote =
    m.role === 'tool' ? ` [tool:${(m as { toolName?: string }).toolName ?? '?'}]` : '';
  return `### ${m.role}${toolNote}\n${content.slice(0, 2000)}`;
}

function extractiveFallback(messages: ChatMessage[]): string {
  const head = messages.slice(0, 3).map(renderMessage).join('\n\n');
  const tail = messages.slice(-5).map(renderMessage).join('\n\n');
  return [
    `[extractive summary — no summarization model available; ${messages.length} earlier messages compacted]`,
    'Earliest messages:',
    head,
    '…',
    'Most recent of the compacted range:',
    tail,
  ].join('\n\n');
}

/**
 * Build the default SessionSummarizer. Safe to use without any API key
 * (falls back to extractive). Uses only free-tier-friendly models.
 */
export function createSummarizer(): (messages: ChatMessage[]) => Promise<string> {
  return async (messages: ChatMessage[]): Promise<string> => {
    if (messages.length === 0) return '[empty range]';
    const input = messages.map(renderMessage).join('\n\n').slice(0, MAX_INPUT_CHARS);
    try {
      const provider = createProvider('groq');
      const turn = await provider.chat(
        [
          {
            role: 'system',
            content:
              'Summarize this agent conversation into a compact briefing for continuing the work. ' +
              'Capture: the user goal, key decisions made, files touched, tool results that matter, ' +
              'and open threads. Be dense and factual. Under 800 tokens.',
          },
          { role: 'user', content: input },
        ],
        [],
        { model: 'llama-3.1-8b-instant' },
      );
      const summary = turn.content?.trim();
      if (summary) return summary;
    } catch {
      // No key / provider down / model unavailable → extractive fallback.
    }
    return extractiveFallback(messages);
  };
}
