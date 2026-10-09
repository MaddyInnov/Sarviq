// SPDX-License-Identifier: Apache-2.0
// Per-bot MBTI persona persistence.
//
// Bot configs ship in seed/bots.json (immutable at runtime, and embedded in
// the single-file binary). Persona selections from the UI are overlaid in
// <dataDir>/bot-personas.json: { "<botId>": "<MBTI>" }. Applied onto the
// in-memory bots at boot (HOST WIRING: call applyBotPersonas(seed.bots,
// config.dataDir) in index.ts) and updated by PUT /api/bots/:id/persona.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePersona, type MbtiType } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';

const PERSONAS_FILE = 'bot-personas.json';

export function botPersonasPath(dataDir: string): string {
  return path.join(dataDir, PERSONAS_FILE);
}

type PersonaFile = Record<string, string>;

function readFile(dataDir: string): PersonaFile {
  try {
    const raw = fs.readFileSync(botPersonasPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as PersonaFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: PersonaFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botPersonasPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botPersonasPath(dataDir));
}

/** Apply persisted personas onto the in-memory bots. Call at boot. */
export function applyBotPersonas(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  const byId = new Map(bots.map((b) => [b.id, b]));
  for (const [botId, persona] of Object.entries(file)) {
    const bot = byId.get(botId);
    if (!bot) continue;
    if (resolvePersona(persona)) bot.persona = (persona as string).trim().toUpperCase() as MbtiType;
  }
}

/** Validate + persist a bot's persona. Returns the normalized persona (or null). Throws on problems. */
export function saveBotPersona(dataDir: string, bots: BotConfig[], botId: string, persona: unknown): MbtiType | null {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  if (persona === null || persona === undefined || (typeof persona === 'string' && !persona.trim())) {
    const file = readFile(dataDir);
    delete file[botId];
    writeFile(dataDir, file);
    bot.persona = null;
    return null;
  }
  if (typeof persona !== 'string' || !resolvePersona(persona)) {
    throw new Error(`persona must be one of the 16 MBTI types (e.g. "INTJ") or null to clear`);
  }
  const normalized = persona.trim().toUpperCase() as MbtiType;
  const file = readFile(dataDir);
  file[botId] = normalized;
  writeFile(dataDir, file);
  bot.persona = normalized;
  return normalized;
}
