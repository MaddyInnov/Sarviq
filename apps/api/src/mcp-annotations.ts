// SPDX-License-Identifier: Apache-2.0
// Read-only-assistant MCP connection class.
//
// External assistants connecting over our MCP server run in one of two
// connection classes:
//   - 'standard'            — the full platform tool surface (unchanged).
//   - 'read-only-assistant' — may READ telemetry/resources freely, but the
//     ONLY write it may perform is `annotations.append` (notes, reports,
//     promises), which lands in the quarantined annotations store
//     (see annotations.ts) for human review.
//
// Enforcement happens in this ToolProvider wrapper, before governance ever
// sees the call: a tool whose required scope (see mcp-scopes.ts
// requiredScopeForTool) is anything other than 'read' — and which is not
// `annotations.append` — is rejected with a `write_denied` error. Measured
// telemetry and assistant annotations never mix: telemetry flows through
// the base provider, annotations through the append-only AnnotationStore,
// and the two are never joined in a single response.

import { requiredScopeForTool } from '@mvp/agent-runtime';
import type { PlatformToolDef, ToolProvider } from '@mvp/agent-runtime';
import { AnnotationStore } from './annotations.js';

/** The single write an external read-only assistant may perform. */
export const ANNOTATIONS_APPEND_TOOL = 'annotations.append';

/** Connection classes for external MCP clients. */
export type McpConnectionClass = 'standard' | 'read-only-assistant';

const APPEND_TOOL_DEF: PlatformToolDef = {
  name: ANNOTATIONS_APPEND_TOOL,
  description:
    'Append a note, report, or promise for human review. ' +
    'This is the ONLY write available to read-only assistant connections: ' +
    'the item is stored separately from measured platform data, labeled as ' +
    'an assistant annotation, and stays pending until a human approves or ' +
    'dismisses it. Never use it to record measured facts.',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['note', 'report', 'promise'],
        description: 'note = observation; report = summary of findings; promise = a commitment the assistant makes.',
      },
      content: { type: 'string', description: 'The annotation text (max 10000 chars).' },
      source: { type: 'string', description: 'Identifier of the appending assistant (default: external-assistant).' },
    },
    required: ['kind', 'content'],
    additionalProperties: false,
  },
};

export interface ReadOnlyAssistantProviderOptions {
  /** Source label applied when the call omits one. */
  defaultSource?: string;
}

/**
 * Wrap a base ToolProvider as a read-only-assistant connection:
 * read-scoped tools pass through, `annotations.append` is served from the
 * store, everything else is denied.
 */
export function createReadOnlyAssistantProvider(
  base: ToolProvider,
  store: AnnotationStore,
  opts: ReadOnlyAssistantProviderOptions = {},
): ToolProvider {
  const defaultSource = opts.defaultSource ?? 'external-assistant';

  return {
    async listTools(): Promise<PlatformToolDef[]> {
      const defs = await base.listTools();
      const readOnly = defs.filter(
        (d) => d.name !== ANNOTATIONS_APPEND_TOOL && requiredScopeForTool(d.name) === 'read',
      );
      return [...readOnly, APPEND_TOOL_DEF];
    },

    async callTool(name: string, args: unknown): Promise<unknown> {
      if (name === ANNOTATIONS_APPEND_TOOL) {
        const params = (args ?? {}) as { kind?: unknown; content?: unknown; source?: unknown };
        const annotation = store.append({
          kind: params.kind as string,
          content: params.content as string,
          source: typeof params.source === 'string' ? params.source : defaultSource,
        });
        return {
          status: 'ok',
          record: 'annotation',
          annotation,
          notice:
            'Stored as a PENDING assistant annotation, separate from measured platform data. ' +
            'A human must approve it before it is treated as reviewed.',
        };
      }
      if (requiredScopeForTool(name) !== 'read') {
        throw new Error(
          `write_denied: tool "${name}" requires the "${requiredScopeForTool(name)}" scope, ` +
            `which read-only assistant connections do not have. ` +
            `The only permitted write is "${ANNOTATIONS_APPEND_TOOL}".`,
        );
      }
      return base.callTool(name, args);
    },
  };
}
