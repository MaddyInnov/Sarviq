// SPDX-License-Identifier: Apache-2.0
// Tests for per-bot MBTI persona persistence (bot-personas.ts):
// - save/apply round-trip via <dataDir>/bot-personas.json
// - validation rejects invalid types and unknown bots
// - clearing with null removes the overlay

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBotPersonas, saveBotPersona } from '../src/bot-personas.js';
import type { BotConfig } from '@mvp/agent-runtime';

let dir: string;

const bots = (): BotConfig[] => [
  {
    id: 'helper', name: 'Helper', description: 'd', systemPrompt: 'p',
    provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [],
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-personas-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bot-personas', () => {
  it('saves and applies a persona', () => {
    const b = bots();
    expect(saveBotPersona(dir, b, 'helper', 'intj')).toBe('INTJ');
    expect(b[0].persona).toBe('INTJ');
    expect(existsSync(join(dir, 'bot-personas.json'))).toBe(true);

    // fresh bot list picks it up via applyBotPersonas
    const b2 = bots();
    applyBotPersonas(b2, dir);
    expect(b2[0].persona).toBe('INTJ');
  });

  it('rejects invalid persona types', () => {
    expect(() => saveBotPersona(dir, bots(), 'helper', 'XXXX')).toThrow(/16 MBTI/);
    expect(() => saveBotPersona(dir, bots(), 'helper', 42)).toThrow(/16 MBTI/);
  });

  it('rejects unknown bots', () => {
    expect(() => saveBotPersona(dir, bots(), 'nope', 'INTJ')).toThrow(/Unknown bot/);
  });

  it('clears with null', () => {
    const b = bots();
    saveBotPersona(dir, b, 'helper', 'ENFP');
    expect(b[0].persona).toBe('ENFP');
    expect(saveBotPersona(dir, b, 'helper', null)).toBeNull();
    expect(b[0].persona).toBeNull();
    const raw = JSON.parse(readFileSync(join(dir, 'bot-personas.json'), 'utf8'));
    expect(raw.helper).toBeUndefined();
  });

  it('applyBotPersonas ignores unknown bot ids in the file', () => {
    const b = bots();
    saveBotPersona(dir, b, 'helper', 'ISTJ');
    const b2 = bots();
    // manually inject a stale entry
    const raw = JSON.parse(readFileSync(join(dir, 'bot-personas.json'), 'utf8'));
    raw.ghost = 'ENTP';
    writeFileSync(join(dir, 'bot-personas.json'), JSON.stringify(raw));
    expect(() => applyBotPersonas(b2, dir)).not.toThrow();
    expect(b2[0].persona).toBe('ISTJ');
  });
});
