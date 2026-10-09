// SPDX-License-Identifier: Apache-2.0
// System-1 decision head (experimental SPIKE): adapter interface, env flag,
// stub backend, and fallback-to-System-2 behavior. No weights, no ONNX.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeModel } from '../src/routing.js';
import {
  SYSTEM1_ENABLED_ENV_VAR,
  StubSystem1Backend,
  System1Router,
  createSystem1Router,
  system1Enabled,
  type System1Backend,
  type System1Decision,
  type System1Features,
} from '../src/system1.js';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[SYSTEM1_ENABLED_ENV_VAR];
  delete process.env[SYSTEM1_ENABLED_ENV_VAR];
});
afterEach(() => {
  if (saved === undefined) delete process.env[SYSTEM1_ENABLED_ENV_VAR];
  else process.env[SYSTEM1_ENABLED_ENV_VAR] = saved;
});

describe('system1Enabled (env gate)', () => {
  it('defaults to OFF', () => {
    expect(system1Enabled()).toBe(false);
  });

  it('accepts 1 / true (case-insensitive)', () => {
    process.env[SYSTEM1_ENABLED_ENV_VAR] = '1';
    expect(system1Enabled()).toBe(true);
    process.env[SYSTEM1_ENABLED_ENV_VAR] = 'TRUE';
    expect(system1Enabled()).toBe(true);
  });

  it('treats anything else as off', () => {
    process.env[SYSTEM1_ENABLED_ENV_VAR] = 'yes';
    expect(system1Enabled()).toBe(false);
    process.env[SYSTEM1_ENABLED_ENV_VAR] = '0';
    expect(system1Enabled()).toBe(false);
  });
});

describe('StubSystem1Backend', () => {
  it('is unavailable and documents the contract on classify', async () => {
    const stub = new StubSystem1Backend();
    expect(stub.available).toBe(false);
    expect(stub.name).toBe('system1-stub');
    await expect(
      stub.classify({ text: 'hi', candidateLabels: ['code'] }),
    ).rejects.toThrow(/system1-intent\.onnx/);
  });
});

describe('System1Router fallback (zero behavior change when off)', () => {
  it('is inactive by default', () => {
    const r = new System1Router();
    expect(r.active).toBe(false);
  });

  it('route() matches routeModel() exactly when disabled', async () => {
    const r = new System1Router();
    const input = { taskType: 'code' as const, providerHint: 'groq' };
    expect(await r.route(input)).toEqual(routeModel(input));
  });

  it('falls back when enabled but the backend is unavailable (stub)', async () => {
    const r = new System1Router({ enabled: true }); // stub backend: unavailable
    expect(r.active).toBe(false);
    const input = { taskType: 'reasoning' as const };
    expect(await r.route(input)).toEqual(routeModel(input));
  });

  it('falls back when a backend throws mid-classify (never breaks the turn)', async () => {
    const flaky: System1Backend = {
      name: 'flaky',
      available: true,
      classify: async () => {
        throw new Error('onnx exploded');
      },
    };
    const r = new System1Router({ enabled: true, backend: flaky });
    expect(r.active).toBe(true);
    const input = { taskType: 'chat' as const };
    expect(await r.route(input)).toEqual(routeModel(input));
  });

  it('falls back on an unknown backend label', async () => {
    const weird: System1Backend = {
      name: 'weird',
      available: true,
      classify: async (f: System1Features): Promise<System1Decision> => ({
        label: 'definitely-not-a-task-type',
        confidence: 0.99,
        latencyMs: 1,
        backend: 'weird',
      }),
    };
    const r = new System1Router({ enabled: true, backend: weird });
    const input = { taskType: 'chat' as const };
    expect(await r.route(input)).toEqual(routeModel(input));
  });
});

describe('System1Router active path', () => {
  function fakeBackend(label: string): System1Backend {
    return {
      name: 'fake-local',
      available: true,
      classify: async (f: System1Features): Promise<System1Decision> => ({
        label,
        confidence: 0.92,
        latencyMs: 12,
        backend: 'fake-local',
      }),
    };
  }

  it('maps a backend label to a task type and routes with it', async () => {
    const r = new System1Router({ enabled: true, backend: fakeBackend('code') });
    expect(r.active).toBe(true);
    const res = await r.route({ taskType: 'chat', message: 'write a function' });
    const expected = routeModel({ taskType: 'code', message: 'write a function' });
    expect(res.providerId).toBe(expected.providerId);
    expect(res.modelId).toBe(expected.modelId);
    expect(res.reason).toContain('System-1 head "fake-local"');
    expect(res.reason).toContain('experimental');
  });

  it('still honors explicit overrides and the free-only guard via routeModel', async () => {
    const r = new System1Router({ enabled: true, backend: fakeBackend('chat') });
    const res = await r.route({ taskType: 'code', botModel: 'groq/gpt-oss-20b' });
    expect(res.providerId).toBe('groq');
    expect(res.modelId).toBe('gpt-oss-20b');
  });

  it('createSystem1Router honors the env flag', () => {
    process.env[SYSTEM1_ENABLED_ENV_VAR] = '1';
    const r = createSystem1Router({ backend: fakeBackend('code') });
    expect(r.active).toBe(true);
    expect(r.backendName).toBe('fake-local');
  });
});
