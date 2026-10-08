// SPDX-License-Identifier: Apache-2.0
// AES-256-GCM envelope storage shared by the vault and wallet packages.
// Follows the providers.ts pattern: machine key file (mode 0600), fresh
// random 96-bit IV per write, atomic temp+rename writes, fail-closed reads.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const GCM_ALG = 'aes-256-gcm';
const GCM_IV_BYTES = 12;
const MACHINE_KEY_BYTES = 32;

/** Encrypted envelope persisted as the whole content of a store file. */
export interface EncryptedEnvelope {
  alg: typeof GCM_ALG;
  /** base64, fresh 96-bit IV per write */
  iv: string;
  /** base64, 128-bit auth tag — verified on every read */
  tag: string;
  /** base64 ciphertext of the UTF-8 JSON payload */
  data: string;
}

/**
 * Write a file atomically (temp + rename) with mode 0600, so a crash
 * mid-write can never leave a truncated key file or store behind.
 */
export function atomicWriteFile(filePath: string, content: string | Buffer): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
}

/**
 * Load the machine key, generating and persisting it on first use.
 * Each key file lives next to the store it protects (same data dir).
 */
export function getOrCreateMachineKey(keyPath: string): Buffer {
  try {
    const raw = readFileSync(keyPath);
    if (raw.length !== MACHINE_KEY_BYTES) {
      throw new Error(
        `[vault] ${keyPath} has an unexpected length (${raw.length} bytes, expected ${MACHINE_KEY_BYTES}) — refusing to use it.`,
      );
    }
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const key = randomBytes(MACHINE_KEY_BYTES);
    mkdirSync(joinDir(keyPath), { recursive: true });
    atomicWriteFile(keyPath, key);
    return key;
  }
}

/** Load the machine key for reading. Fails closed if it is missing. */
export function requireMachineKey(keyPath: string): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[vault] machine key ${keyPath} is missing but the store is encrypted — refusing to read. ` +
          `The key file was deleted or the data dir changed; secrets must be re-entered.`,
      );
    }
    throw err;
  }
  if (raw.length !== MACHINE_KEY_BYTES) {
    throw new Error(`[vault] ${keyPath} has an unexpected length — refusing to read secrets.`);
  }
  return raw;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.alg === GCM_ALG &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.data === 'string'
  );
}

/**
 * Read + decrypt a store file. Missing file → `fallback`. Tampered/wrong-key
 * → throws (fail closed, never plaintext fallback).
 */
export function readEncryptedJson<T>(filePath: string, keyPath: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`[vault] ${filePath} is not valid JSON — refusing to read secrets.`);
  }
  if (!isEncryptedEnvelope(parsed)) {
    throw new Error(
      `[vault] ${filePath} is not an encrypted envelope (plaintext store?) — refusing to read secrets.`,
    );
  }
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`[vault] ${filePath} has an invalid IV — the file may be tampered with. Refusing to read.`);
  }
  const decipher = createDecipheriv(GCM_ALG, requireMachineKey(keyPath), iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    // Wrong key, tampered ciphertext, or corrupt file: GCM auth failed.
    throw new Error(
      `[vault] ${filePath} failed authentication (wrong key, tampered or corrupt file). Refusing to read secrets.`,
    );
  }
}

/** Encrypt + atomically write a JSON payload. Fresh random IV per write. */
export function writeEncryptedJson(filePath: string, keyPath: string, payload: unknown): void {
  const key = getOrCreateMachineKey(keyPath);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_ALG, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    alg: GCM_ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  mkdirSync(joinDir(filePath), { recursive: true });
  atomicWriteFile(filePath, JSON.stringify(envelope) + '\n');
}

function joinDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '.' : filePath.slice(0, idx);
}
