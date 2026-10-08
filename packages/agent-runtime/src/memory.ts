// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';

/**
 * Bot ids are used as file names, so restrict them to a safe alphabet.
 * Rejects path traversal (e.g. "../../etc") fail-closed.
 */
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkBotId(botId: string): void {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new Error(
      `Invalid bot id "${botId}": must match ${BOT_ID_PATTERN.source} (memory file names are derived from bot ids)`,
    );
  }
}

/**
 * Per-bot persistent memory: one markdown file per bot at
 * `<dataDir>/memories/<botId>.md`. Survives sessions and restarts — it is
 * just a file on disk.
 *
 * Two write modes:
 * - append(): timestamped journal entries (bot's memory_store tool).
 * - replace(): full rewrite (used by the Workspace UI's memory editor).
 *
 * NOTE (follow-up for the Workspace UI, owned by the top coordinator):
 * expose this over HTTP as GET/PUT /api/bots/:id/memory so users can read
 * and edit bot memory from the dashboard. The store class below is already
 * safe to call from a route handler.
 */
export class BotMemoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'memories');
  }

  /** Absolute path of a bot's memory file (handy for debugging/tests). */
  path(botId: string): string {
    checkBotId(botId);
    return join(this.dir, `${botId}.md`);
  }

  /** Read the bot's memory file; returns '' when it has no memory yet. */
  read(botId: string): string {
    checkBotId(botId);
    try {
      return readFileSync(this.path(botId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Append a timestamped markdown section. Creates the dir/file as needed. */
  append(botId: string, entry: string): void {
    checkBotId(botId);
    const text = entry.trim();
    if (!text) throw new Error('memory_store: "entry" must be a non-empty string');
    mkdirSync(this.dir, { recursive: true });
    const existing = this.read(botId);
    const section = `## ${new Date().toISOString()}\n\n${text}\n`;
    const next = existing ? (existing.endsWith('\n') ? existing : existing + '\n') + '\n' + section : section;
    writeFileSync(this.path(botId), next, 'utf8');
  }

  /** Full replace of the memory file (user edits from the UI). */
  replace(botId: string, content: string): void {
    checkBotId(botId);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(botId), content, 'utf8');
  }
}

export interface CreateMemoryToolsOptions {
  store: BotMemoryStore;
}

/**
 * Two tools, both scoped to the calling bot via ctx.botId:
 * - memory_recall: returns the bot's memory file content ('' if none yet).
 * - memory_store: appends a timestamped fact to the bot's memory.
 *
 * Governance: memory_store is a write tool, so it goes through the normal
 * approval flow like any other tool — nothing here bypasses Phase 1 policy.
 * Deliberately minimal: no system-prompt injection; the bot discovers its
 * memory through the tool descriptions, which the model sees.
 */
export function createMemoryTools(opts: CreateMemoryToolsOptions): ToolDefinition[] {
  const { store } = opts;

  const recall: ToolDefinition = {
    name: 'memory_recall',
    description:
      'Read your persistent memory: durable facts you chose to remember across ' +
      'conversations (preferences, project state, user details). Returns the ' +
      'memory file content, or empty text if nothing is stored yet. Call it ' +
      'when past context would help the current task.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, unknown>, ctx: ToolContext) => {
      return { content: store.read(ctx.botId) };
    },
  };

  const storeTool: ToolDefinition = {
    name: 'memory_store',
    description:
      'Save a durable fact to your persistent memory (survives sessions). ' +
      'Use for user preferences, project decisions, and anything you will ' +
      'need in future conversations. Do NOT store secrets, credentials, or ' +
      'private data the user did not ask you to remember.',
    parameters: {
      type: 'object',
      properties: {
        entry: {
          type: 'string',
          description: 'The fact to remember, as a short markdown paragraph.',
        },
      },
      required: ['entry'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const entry = typeof args.entry === 'string' ? args.entry : '';
      store.append(ctx.botId, entry);
      return { stored: true, botId: ctx.botId };
    },
  };

  return [recall, storeTool];
}
