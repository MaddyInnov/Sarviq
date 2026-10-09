// SPDX-License-Identifier: Apache-2.0
// Feature interconnection (P2-E): agent tools that link bots ↔ workflows ↔ notes.
//
//   workflow_start  — a bot in chat starts a workflow run (params: workflowId + input)
//   notes_save      — a bot saves a note mid-conversation (create or update)
//   notes_read      — a bot reads a note by id
//   notes_search    — a bot searches notes by keyword
//
// Governance: explicit policy rules are exported as
// interconnectionPolicyRules() — prepend them to the global policy in
// index.ts (first match wins), next to computerUsePolicyRules() and
// museModuleToolPolicies():
//
//   const globalPolicy: Policy = {
//     ...DEFAULT_POLICY,
//     rules: [...interconnectionPolicyRules(), ...computerUsePolicyRules(), ...],
//   };
//
// Reads (notes_read/notes_search) are auto-allowed like read_file; the two
// mutating tools (workflow_start/notes_save) require human approval, which
// keeps the Phase-1 deny-by-default trust floor intact.
//
// Mount at boot, e.g. right after the WorkflowRunner is constructed:
//   import { registerInterconnectionTools } from './interconnect-tools.js';
//   registerInterconnectionTools({
//     registry: toolRegistry,
//     workflowRunner,
//     dataDir: config.dataDir,
//   });

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { WorkflowRunner } from '@mvp/workflows';
import { NoteStore } from './notes.js';
import { KnowledgeIndex } from './knowledge.js';

/**
 * Explicit governance rules for the interconnection tools. The integrator
 * prepends these to the global policy (first match wins):
 * read-only note tools auto-allow; workflow starts and note writes need
 * human approval — strictly stronger than the deny-by-default fallback.
 */
export function interconnectionPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'interconnect-notes-read-allow',
      toolPattern: '^(notes_read|notes_search)$',
      effect: 'allow',
      reason: 'Reading/searching the user\'s own notes is read-only observation',
    },
    {
      id: 'interconnect-workflow-start-approval',
      toolPattern: '^workflow_start$',
      effect: 'require-approval',
      reason: 'Starting a workflow run kicks off background multi-step work; needs human approval',
    },
    {
      id: 'interconnect-notes-save-approval',
      toolPattern: '^notes_save$',
      effect: 'require-approval',
      reason: "Saving a note mutates the user's notes; needs human approval",
    },
  ];
}

export interface InterconnectionToolDeps {
  registry: Map<string, ToolDefinition>;
  workflowRunner: WorkflowRunner;
  dataDir: string;
}

function strArg(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  const s = v.trim();
  if (required && s.length === 0) throw new Error(`"${key}" must be a non-empty string`);
  return s;
}

function workflowStartTool(runner: WorkflowRunner): ToolDefinition {
  return {
    name: 'workflow_start',
    description: [
      'Start a workflow run by workflow id. Use it when the user asks to run',
      'an automation, or when a multi-step job fits a registered workflow',
      'better than doing it inline in chat.',
      '',
      'Args:',
      '- workflowId (string, required): id of a registered workflow.',
      '- input (any, optional): JSON input handed to the workflow run.',
      '- idempotencyKey (string, optional): when set, a repeated call with',
      '  the same key returns the existing run instead of starting a new one.',
      '',
      'Returns { runId, workflowId, status }. The run executes in the',
      'background; use the Workflows UI or API to follow its progress.',
      'Requires human approval (governance policy).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Id of a registered workflow' },
        input: { description: 'JSON input for the workflow run' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key' },
      },
      required: ['workflowId'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
      const workflowId = strArg(args, 'workflowId', true)!;
      // Validate before starting so the bot gets a clear error for typos.
      try {
        runner.getWorkflow(workflowId);
      } catch {
        throw new Error(`workflow_start: unknown workflow "${workflowId}"`);
      }
      const idempotencyKey = strArg(args, 'idempotencyKey', false);
      const run = await runner.startRun(
        workflowId,
        args['input'] ?? {},
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      return { runId: run.id, workflowId: run.workflowId, status: run.status };
    },
  };
}

function notesSaveTool(noteStore: NoteStore): ToolDefinition {
  return {
    name: 'notes_save',
    description: [
      "Save a note to the user's notes. Creates a new note, or updates the",
      'existing one when "id" is given. Use it to remember decisions, facts,',
      'or follow-ups from the conversation.',
      '',
      'Args:',
      '- title (string, required): note title (max 200 chars).',
      '- content (string, optional): markdown body.',
      '- id (string, optional): update this note instead of creating one.',
      '',
      'Requires human approval (governance policy).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title (max 200 chars)' },
        content: { type: 'string', description: 'Markdown body' },
        id: { type: 'string', description: 'Update this note id instead of creating' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
      const title = strArg(args, 'title', true)!;
      const id = strArg(args, 'id', false);
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      const note = id ? noteStore.update(id, { title, content }) : noteStore.create({ title, content });
      return { id: note.id, title: note.title, updatedAt: note.updatedAt };
    },
  };
}

function notesReadTool(noteStore: NoteStore): ToolDefinition {
  return {
    name: 'notes_read',
    description: [
      "Read a note by id (full markdown content). Pair with notes_search to",
      'find the id first. Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
      const id = strArg(args, 'id', true)!;
      const note = noteStore.get(id);
      if (!note) throw new Error(`notes_read: unknown note "${id}"`);
      return note;
    },
  };
}

function notesSearchTool(noteStore: NoteStore): ToolDefinition {
  return {
    name: 'notes_search',
    description: [
      "Search the user's notes by keyword (title + content). Returns",
      'summaries — call notes_read with an id for the full content. Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
      const query = strArg(args, 'query', true)!;
      const rawLimit = args['limit'];
      const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(50, Math.floor(rawLimit)))
          : 10;
      const hits = new KnowledgeIndex(noteStore).search(query).slice(0, limit);
      return hits.map((n) => ({
        id: n.id,
        title: n.title,
        snippet: n.content.slice(0, 200),
        updatedAt: n.updatedAt,
      }));
    },
  };
}

/** Register workflow_start + the notes tools in the shared tool registry. */
export function registerInterconnectionTools(deps: InterconnectionToolDeps): void {
  const noteStore = new NoteStore(deps.dataDir);
  const tools = [
    workflowStartTool(deps.workflowRunner),
    notesSaveTool(noteStore),
    notesReadTool(noteStore),
    notesSearchTool(noteStore),
  ];
  for (const tool of tools) {
    if (!deps.registry.has(tool.name)) {
      deps.registry.set(tool.name, tool);
    }
  }
}
