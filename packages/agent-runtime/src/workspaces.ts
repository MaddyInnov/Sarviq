// SPDX-License-Identifier: Apache-2.0
// Per-bot workspaces — Octop-style isolation: each bot can have its own
// workspace directory so two bots working simultaneously don't collide.
//
// Semantics (BotConfig.workspace):
// - unset/empty → the bot uses the global workspaceDir (backward compatible).
// - relative (e.g. "coder") → resolved against <dataDir>/workspaces.
// - absolute → must be inside <dataDir> (enforced); otherwise rejected.
//
// Security: the resolved directory always stays inside dataDir for bot-local
// workspaces, and confine() still applies per-call against the resolved root.

import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ToolContext } from './types.js';

/** A workspace root: fixed string, or resolved per tool-call from context. */
export type WorkspaceSource = string | ((ctx: ToolContext) => string);

/** Resolve a WorkspaceSource to an absolute directory for this call. */
export function resolveWorkspaceDir(source: WorkspaceSource, ctx: ToolContext): string {
  return typeof source === 'string' ? source : source(ctx);
}

/**
 * Validate a user-supplied bot workspace value.
 * Returns the trimmed value. Throws on invalid input.
 * - Empty string → '' (means "use global workspace", i.e. unset).
 * - Relative: 1-80 chars, letters/digits/_-./, no leading dot, no '..'.
 * - Absolute: must resolve inside dataDir.
 */
export function validateBotWorkspace(value: unknown, dataDir: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error('workspace must be a string');
  const v = value.trim();
  if (!v) return '';
  if (v.length > 256) throw new Error('workspace path too long (max 256 chars)');
  if (isAbsolute(v)) {
    const dataRoot = resolve(dataDir);
    const abs = resolve(v);
    if (abs !== dataRoot && !abs.startsWith(dataRoot + sep)) {
      throw new Error('absolute workspace must be inside the server data directory');
    }
    return abs;
  }
  // Relative: strict charset, no traversal.
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,79}$/.test(v)) {
    throw new Error(
      'relative workspace must be 1-80 chars: letters, digits, _ . / -, starting with a letter or digit (e.g. "coder")',
    );
  }
  if (v.split('/').includes('..')) throw new Error('workspace must not contain ".."');
  return v;
}

/**
 * Resolve the effective workspace directory for a bot.
 * Creates the directory if it doesn't exist.
 */
export function resolveBotWorkspaceDir(opts: {
  botWorkspace?: string | null;
  globalWorkspaceDir: string;
  dataDir: string;
}): string {
  const { botWorkspace, globalWorkspaceDir, dataDir } = opts;
  if (!botWorkspace) return resolve(globalWorkspaceDir);
  const v = botWorkspace.trim();
  if (!v) return resolve(globalWorkspaceDir);
  let dir: string;
  if (isAbsolute(v)) {
    const dataRoot = resolve(dataDir);
    const abs = resolve(v);
    if (abs !== dataRoot && !abs.startsWith(dataRoot + sep)) {
      // Config drift / tampering — fail closed to the global workspace.
      throw new Error('bot workspace escapes the data directory');
    }
    dir = abs;
  } else {
    dir = resolve(join(resolve(dataDir), 'workspaces', v));
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a per-call workspace resolver for tool factories. */
export function makeWorkspaceResolver(opts: {
  getBotWorkspace: (botId: string) => string | undefined;
  globalWorkspaceDir: string;
  dataDir: string;
}): (ctx: ToolContext) => string {
  return (ctx) =>
    resolveBotWorkspaceDir({
      botWorkspace: ctx ? opts.getBotWorkspace(ctx.botId) : undefined,
      globalWorkspaceDir: opts.globalWorkspaceDir,
      dataDir: opts.dataDir,
    });
}
