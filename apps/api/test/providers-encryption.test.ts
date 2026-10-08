// SPDX-License-Identifier: Apache-2.0
// Tests for encrypted-at-rest provider key storage (apps/api/src/providers.ts):
// - save/remove round-trips through AES-256-GCM encryption
// - machine key file created with mode 0600 on first write
// - legacy plaintext files are migrated to encrypted form on load
// - tampered ciphertext fails closed (throws, no silent plaintext fallback)
// - the ciphertext on disk never contains the key bytes

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localKeysPath, removeProviderKey, saveProviderKey, syncProviderKeysToEnv } from '../src/providers.js';

const TEST_SECRET = 'sk-test-encryption-target-9f8e7d6c5b4a';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-providers-enc-'));
}

function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

describe('provider key encryption at rest', () => {
  it('round-trips a key through encryption and never leaves plaintext on disk', () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'custom-acme', { apiKey: TEST_SECRET });
    const raw = readFileSync(localKeysPath(dataDir), 'utf8');
    expect(raw).not.toContain(TEST_SECRET);
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.tag).toBe('string');
    expect(typeof envelope.data).toBe('string');
    // The key is readable back through the API.
    expect(removeProviderKey(dataDir, 'custom-acme')).toBe(true);
    expect(removeProviderKey(dataDir, 'custom-acme')).toBe(false);
  });

  it('uses a fresh random IV per write', () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'custom-acme', { apiKey: TEST_SECRET });
    const first = readFileSync(localKeysPath(dataDir), 'utf8');
    saveProviderKey(dataDir, 'custom-acme', { apiKey: TEST_SECRET });
    const second = readFileSync(localKeysPath(dataDir), 'utf8');
    expect(first).not.toBe(second);
    expect(second).not.toContain(TEST_SECRET);
  });

  it('creates the machine key and key file with mode 0600', () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'custom-acme', { apiKey: TEST_SECRET });
    const keyPath = join(dataDir, '.machine-key');
    expect(modeOf(keyPath)).toBe(0o600);
    expect(readFileSync(keyPath).length).toBe(32);
    expect(modeOf(localKeysPath(dataDir))).toBe(0o600);
  });

  it('migrates a legacy plaintext file to encrypted form on load', () => {
    const dataDir = freshDataDir();
    writeFileSync(
      localKeysPath(dataDir),
      JSON.stringify({ CUSTOM_ACME_API_KEY: TEST_SECRET }) + '\n',
      { mode: 0o600 },
    );
    // Any read path (here via saveProviderKey) triggers the migration.
    saveProviderKey(dataDir, 'custom-other', { apiKey: 'other-secret' });
    const raw = readFileSync(localKeysPath(dataDir), 'utf8');
    expect(raw).not.toContain(TEST_SECRET);
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope.alg).toBe('aes-256-gcm');
    // Both keys survive the migration.
    expect(removeProviderKey(dataDir, 'custom-acme')).toBe(true);
    expect(removeProviderKey(dataDir, 'custom-other')).toBe(true);
  });

  it('fails closed on tampered ciphertext', () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'custom-acme', { apiKey: TEST_SECRET });
    const filePath = localKeysPath(dataDir);
    const envelope = JSON.parse(readFileSync(filePath, 'utf8')) as { data: string };
    // Flip a byte in the middle of the ciphertext.
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    envelope.data = bytes.toString('base64');
    writeFileSync(filePath, JSON.stringify(envelope) + '\n');
    expect(() => removeProviderKey(dataDir, 'custom-acme')).toThrow(/failed authentication/i);
    // No silent fallback on the write path either.
    expect(() => saveProviderKey(dataDir, 'custom-acme', { apiKey: 'x' })).toThrow();
  });

  it('fails closed when the machine key is missing but ciphertext exists', () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'custom-acme', { apiKey: TEST_SECRET });
    // Simulate a lost/rotated key file: reads must refuse, not return {}.
    rmSync(join(dataDir, '.machine-key'));
    expect(() => removeProviderKey(dataDir, 'custom-acme')).toThrow(/machine-key/i);
  });
});

describe('provider key env bridging (runtime key resolution)', () => {
  const OLD_ENV = { ...process.env };

  function restoreEnv() {
    for (const k of Object.keys(process.env)) {
      if (!(k in OLD_ENV)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(OLD_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it('syncProviderKeysToEnv injects decrypted keys without overwriting real env vars', () => {
    const dataDir = freshDataDir();
    // A real user-exported env var must win over the file.
    process.env['CUSTOM_ACME_API_KEY'] = 'real-env-key';
    try {
      saveProviderKey(dataDir, 'custom-acme', { apiKey: 'file-key' });
      // saveProviderKey must not clobber the real env var either.
      expect(process.env['CUSTOM_ACME_API_KEY']).toBe('real-env-key');
      delete process.env['CUSTOM_ACME_API_KEY'];
      syncProviderKeysToEnv(dataDir);
      expect(process.env['CUSTOM_ACME_API_KEY']).toBe('file-key');
    } finally {
      restoreEnv();
    }
  });

  it('removeProviderKey unsets only API-injected keys, never real env vars', () => {
    const dataDir = freshDataDir();
    process.env['CUSTOM_ACME_API_KEY'] = 'real-env-key';
    try {
      saveProviderKey(dataDir, 'custom-acme', { apiKey: 'file-key' });
      // Real env var untouched by save...
      expect(process.env['CUSTOM_ACME_API_KEY']).toBe('real-env-key');
      removeProviderKey(dataDir, 'custom-acme');
      // ...and untouched by remove.
      expect(process.env['CUSTOM_ACME_API_KEY']).toBe('real-env-key');
    } finally {
      restoreEnv();
    }
    // Injected keys are cleaned up on remove.
    const dataDir2 = freshDataDir();
    try {
      saveProviderKey(dataDir2, 'custom-acme', { apiKey: 'file-key' });
      expect(process.env['CUSTOM_ACME_API_KEY']).toBe('file-key');
      removeProviderKey(dataDir2, 'custom-acme');
      expect(process.env['CUSTOM_ACME_API_KEY']).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });
});
