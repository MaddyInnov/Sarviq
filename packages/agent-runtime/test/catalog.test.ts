// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDefaultModel,
  getProviderPreset,
  listProviderPresets,
  resolveApiKey,
  resolveBaseUrl,
} from '../src/providers/catalog.js';
import { createProvider } from '../src/providers/factory.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';

const ENV_KEYS = [
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OMNIRUSH_API_KEY',
  'PROVIDERS_FILE',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PROVIDERS_FILE = join(tmpdir(), 'agent-runtime-test-no-such-providers.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('catalog', () => {
  it('exposes the expected provider presets', () => {
    const ids = listProviderPresets().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['groq', 'openrouter', 'openai', 'anthropic', 'omnirush']));
    expect(getProviderPreset('openrouter')?.liveModels).toBe(true);
    expect(getProviderPreset('groq')?.envKey).toBe('GROQ_API_KEY');
    expect(getDefaultModel('groq')).toBe('gpt-oss-120b');
    expect(getProviderPreset('nope')).toBeUndefined();
  });

  it('resolveApiKey reads the env var first', () => {
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    expect(resolveApiKey('openrouter')).toBe('or-env-key');
  });

  it('resolveApiKey falls back to providers.local.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(file, JSON.stringify({ ANTHROPIC_API_KEY: 'anthropic-file-key' }), { mode: 0o600 });
    process.env.PROVIDERS_FILE = file;
    expect(resolveApiKey('anthropic')).toBe('anthropic-file-key');
  });

  it('resolveApiKey returns undefined when nothing is configured', () => {
    expect(resolveApiKey('groq')).toBeUndefined();
  });

  it('createProvider names the env var when the key is missing', () => {
    expect(() => createProvider('groq')).toThrow(/GROQ_API_KEY/);
  });

  it('createProvider rejects unknown providers', () => {
    expect(() => createProvider('nope')).toThrow(/Unknown provider/);
  });
});

describe('omnirush bring-your-own preset', () => {
  it('exists, is marked byo, and ships with an empty baseUrl', () => {
    const preset = getProviderPreset('omnirush');
    expect(preset).toBeDefined();
    expect(preset?.byo).toBe(true);
    expect(preset?.baseUrl).toBe('');
    expect(preset?.envKey).toBe('OMNIRUSH_API_KEY');
    expect(preset?.api).toBe('openai-compatible');
    expect(preset?.models).toEqual([]);
    expect(preset?.notes).toMatch(/own/i);
  });

  it('createProvider throws a helpful configuration error when no baseUrl is set', () => {
    expect(() => createProvider('omnirush')).toThrow(/bring-your-own/i);
    expect(() => createProvider('omnirush')).toThrow(/Providers settings page/);
    expect(() => createProvider('omnirush')).toThrow(/OMNIRUSH_API_KEY/);
  });

  it('resolveApiKey checks OMNIRUSH_API_KEY env then providers.local.json', () => {
    process.env.OMNIRUSH_API_KEY = 'own-env-key';
    expect(resolveApiKey('omnirush')).toBe('own-env-key');
    delete process.env.OMNIRUSH_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'agent-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(file, JSON.stringify({ OMNIRUSH_API_KEY: 'own-file-key' }), { mode: 0o600 });
    process.env.PROVIDERS_FILE = file;
    expect(resolveApiKey('omnirush')).toBe('own-file-key');
  });

  it('becomes usable once the user configures their own endpoint + key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(
      file,
      JSON.stringify({
        OMNIRUSH_API_KEY: 'own-key',
        OMNIRUSH_API_KEY_BASE_URL: 'https://my-own-omnirush.example/v1',
      }),
      { mode: 0o600 },
    );
    process.env.PROVIDERS_FILE = file;
    expect(resolveBaseUrl('omnirush')).toBe('https://my-own-omnirush.example/v1');
    const provider = createProvider('omnirush');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerId).toBe('omnirush');
  });
});
