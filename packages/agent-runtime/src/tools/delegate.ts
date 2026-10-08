// SPDX-License-Identifier: Apache-2.0

import type { ToolContext, ToolDefinition } from '../types.js';
import { MAX_SUBAGENT_DEPTH, spawnSubagent } from '../subagents.js';
import type { SubagentAuditFn, SubagentSpawnFn } from '../subagents.js';
import { SubagentStore } from '../subagent-store.js';

export interface CreateDelegateToolsOptions {
  /**
   * Host-injected subagent implementation (top coordinator wires the real
   * one: a child AgentRuntime turn under the same governance policy).
   */
  spawn: SubagentSpawnFn;
  /**
   * STRONGLY RECOMMENDED. Enables the nesting depth limit and the
   * parent/child records that the Audit/Activity UI shows. Without it the
   * tool still spawns, but depth cannot be enforced and no records or
   * `subagent.*` audit events are produced.
   */
  store?: SubagentStore;
  /** Audit sink for `subagent.spawned` / `subagent.finished` events. */
  audit?: SubagentAuditFn;
  /** Override the nesting cap (default MAX_SUBAGENT_DEPTH = 2). */
  maxDepth?: number;
}

/**
 * `delegate` — the tool a bot calls to spawn a subagent for a subtask.
 *
 * Governance: this is an ordinary registry tool, so it passes through the
 * SAME deny-by-default approval flow as every other tool (it is NOT
 * pre-approved — Phase 1 trust floor is preserved). The spawned child runs
 * under the same governance policy as the parent; MCP tools stay
 * approval-gated inside the child, and child tool outputs are tagged
 * untrusted exactly like the parent's.
 *
 * Recursion guard, two layers:
 *  1. `delegate` is stripped from the tool subset handed to the child
 *     (both when the caller omits `tools` and when it names them
 *     explicitly) — the host should additionally default an omitted `tools`
 *     list to "the parent bot's tools minus delegate".
 *  2. Nesting depth is enforced via the SubagentStore: a session at
 *     `maxDepth` (default 2: root → child → grandchild) cannot delegate;
 *     the call fails with a clear error instead of spawning.
 */
export function createDelegateTools(opts: CreateDelegateToolsOptions): ToolDefinition[] {
  const { spawn, store, audit } = opts;
  const maxDepth = opts.maxDepth ?? MAX_SUBAGENT_DEPTH;

  const delegateTool: ToolDefinition = {
    name: 'delegate',
    description: [
      'Spawn a subagent to handle a subtask independently, then return its result.',
      'Use it to parallelize research, run a bounded investigation, or isolate a',
      'risky multi-step job from the main conversation.',
      '',
      'Args:',
      '- task (string, required): a self-contained description of the subtask,',
      '  including what output you need back. The subagent does NOT see this',
      '  conversation, so include all necessary context in the task text.',
      '- tools (string[], optional): the tool names the subagent may use.',
      '  When omitted the host defaults to all tools this bot has, EXCLUDING',
      '  "delegate" itself.',
      '',
      'Safety: this call goes through the normal tool-approval flow, the child',
      'runs under the same governance policy, and delegation nests at most',
      `${maxDepth} deep (root -> child -> grandchild). A subagent at the depth`,
      'limit cannot delegate further. Returns the subagent\'s final text.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Self-contained subtask description, with all context the subagent needs.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional subset of tool names the subagent may use. "delegate" is always removed. ' +
            'Omit to let the host default to the parent bot\'s tools minus delegate.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) {
        throw new Error('delegate: "task" must be a non-empty string');
      }

      // Strip `delegate` from any explicit subset — the child must not be
      // able to recurse unboundedly through the same tool.
      const requested = Array.isArray(args.tools)
        ? (args.tools as unknown[]).map(String).filter((t) => t && t !== 'delegate')
        : undefined;

      if (!store) {
        // Minimal wiring: spawn without depth enforcement or records.
        // Hosts SHOULD pass a SubagentStore (see options docs).
        const result = await spawn({
          task,
          tools: requested,
          botId: ctx.botId,
          parentSessionId: ctx.sessionId,
        });
        return { result: result.result, usage: result.usage ?? null };
      }

      const spawned = await spawnSubagent({
        store,
        spawn,
        audit,
        maxDepth,
        parentBotId: ctx.botId,
        parentSessionId: ctx.sessionId,
        task,
        tools: requested,
        botId: ctx.botId,
      });
      return {
        result: spawned.result,
        usage: spawned.usage ?? null,
        subagentId: spawned.subagentId,
      };
    },
  };

  return [delegateTool];
}
