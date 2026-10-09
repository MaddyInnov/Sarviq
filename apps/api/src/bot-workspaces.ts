// SPDX-License-Identifier: Apache-2.0
// Per-bot workspace persistence (Octop-style isolation).
//
// Bot configs ship in seed/bots.json (immutable at runtime, and embedded in
// the single-file binary). Workspace selections from the UI are overlaid in
// <dataDir>/bot-workspaces.json: { "<botId>": "<workspace>" }. Applied onto
// the in-memory bots at boot (HOST WIRING: call applyBotWorkspaces(seed.bots,
// config.dataDir) in index.ts) and updated by PUT /api/bots/:id/workspace.
//
// Workspace value semantics (see @mvp/agent-runtime workspaces.ts):
// - "" (empty) → bot uses the global workspaceDir (default, backward compat).
// - relative (e.g. "coder") → <dataDir>/workspaces/coder.
// - absolute → must be inside dataDir.

import fs from 'node:fs';
import path from 'node:path';
import { validateBotWorkspace } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';

const WORKSPACES_FILE = 'bot-workspaces.json';

export function botWorkspacesPath(dataDir: string): string {
  return path.join(dataDir, WORKSPACES_FILE);
}

type WorkspaceFile = Record<string, string>;

function readFile(dataDir: string): WorkspaceFile {
  try {
    const raw = fs.readFileSync(botWorkspacesPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as WorkspaceFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: WorkspaceFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botWorkspacesPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botWorkspacesPath(dataDir));
}

/** Apply persisted workspaces onto the in-memory bots. Call at boot. */
export function applyBotWorkspaces(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  const byId = new Map(bots.map((b) => [b.id, b]));
  for (const [botId, workspace] of Object.entries(file)) {
    const bot = byId.get(botId);
    if (!bot) continue;
    try {
      const validated = validateBotWorkspace(workspace, dataDir);
      if (validated) bot.workspace = validated;
      else delete bot.workspace;
    } catch {
      // Invalid persisted value — ignore, bot falls back to global workspace.
    }
  }
}

/** Persist a bot's workspace selection. Empty string clears it (→ global). */
export function saveBotWorkspace(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  workspace: unknown,
): string {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  const validated = validateBotWorkspace(workspace, dataDir);
  const file = readFile(dataDir);
  if (validated) {
    file[botId] = validated;
    bot.workspace = validated;
  } else {
    delete file[botId];
    delete bot.workspace;
  }
  writeFile(dataDir, file);
  return validated;
}
