// SPDX-License-Identifier: Apache-2.0
// Custom slash commands — the `/work` pattern from Claude Code.
//
// In Claude Code, `/work` is not built-in; it is a USER-DEFINED command
// (a markdown instruction file). The platform feature is the slash-command
// system itself: users define named commands with a prompt template, then
// invoke them in chat as `/name args`. The template expands before the
// message reaches the agent.
//
// Storage: <dataDir>/slash-commands.json
//   { "<name>": { "description": "...", "prompt": "..." } }
// Template placeholders: {args} (text after the command), {message} (full
// original message).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_FILE = 'slash-commands.json';

export interface SlashCommand {
  description: string;
  prompt: string;
}

export type SlashCommandMap = Record<string, SlashCommand>;

function commandsPath(dataDir: string): string {
  return path.join(dataDir, COMMANDS_FILE);
}

/** Seed file shipped with the product (default commands like /work, /plan). */
function seedCommandsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ → ../../seed/slash-commands.json ; dist/ → ../../seed/slash-commands.json
  return path.join(here, '..', '..', 'seed', 'slash-commands.json');
}

export function loadSlashCommands(dataDir: string): SlashCommandMap {
  // Try the data dir first, then fall back to the seed file (shipped defaults).
  const candidates = [commandsPath(dataDir), seedCommandsPath()];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const out: SlashCommandMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (/^[a-z0-9-]{1,32}$/.test(k) && typeof v === 'object' && v !== null) {
          const c = v as Record<string, unknown>;
          if (typeof c.prompt === 'string' && c.prompt.length > 0 && c.prompt.length <= 8000) {
            out[k] = {
              description: typeof c.description === 'string' ? c.description.slice(0, 200) : '',
              prompt: c.prompt,
            };
          }
        }
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      continue;
    }
  }
  return {};
}

export function saveSlashCommand(dataDir: string, name: string, cmd: SlashCommand): SlashCommandMap {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) {
    throw new Error('Command name must be 1-32 chars: lowercase letters, digits, hyphens.');
  }
  if (!cmd.prompt || cmd.prompt.length > 8000) {
    throw new Error('prompt is required (max 8000 chars).');
  }
  const all = loadSlashCommands(dataDir);
  all[name] = {
    description: (cmd.description ?? '').slice(0, 200),
    prompt: cmd.prompt,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(commandsPath(dataDir), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  return all;
}

export function deleteSlashCommand(dataDir: string, name: string): boolean {
  const all = loadSlashCommands(dataDir);
  if (!(name in all)) return false;
  delete all[name];
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(commandsPath(dataDir), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  return true;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

/** Parse a leading `/name args` from a chat message. Returns null if not a command. */
export function parseSlashCommand(message: string): ParsedCommand | null {
  const m = /^\/([a-z0-9-]{1,32})(?:\s+(.*))?$/s.exec(message.trim());
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

/**
 * Expand a message through the slash-command registry. If the message is a
 * known `/command`, returns the expanded prompt; otherwise returns the
 * message unchanged. Unknown `/command` → returns null so the caller can
 * surface a helpful error.
 */
export function expandSlashCommand(
  message: string,
  commands: SlashCommandMap,
): { expanded: string; commandName: string } | { expanded: string; commandName: null } | null {
  const parsed = parseSlashCommand(message);
  if (!parsed) return { expanded: message, commandName: null };
  const cmd = commands[parsed.name];
  if (!cmd) return null; // unknown command
  const expanded = cmd.prompt
    .replaceAll('{args}', parsed.args)
    .replaceAll('{message}', message.trim());
  return { expanded, commandName: parsed.name };
}
