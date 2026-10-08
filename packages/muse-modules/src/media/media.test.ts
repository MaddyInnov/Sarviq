// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import { MockMediaProvider, resolveMediaProvider } from './index.js';

describe('MockMediaProvider', () => {
  const provider = new MockMediaProvider();

  it('generates all three kinds with fixture URLs', async () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      const asset = await provider.generate(kind, `a ${kind} of a lighthouse`);
      expect(asset.kind).toBe(kind);
      expect(asset.provider).toBe('mock');
      expect(asset.url).toMatch(/^mock:\/\/media\/.+\.(png|mp4|wav)$/);
      expect(asset.prompt).toContain('lighthouse');
    }
  });

  it('image fixture bytes are a real PNG', async () => {
    const asset = await provider.generate('image', 'sunset');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.byteLength).toBeGreaterThan(0);
    const bytes = provider.fixtureImageBytes();
    expect(bytes.length).toBe(asset.byteLength);
    // PNG magic bytes
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('validates kind and prompt', async () => {
    await expect(provider.generate('hologram' as never, 'x')).rejects.toThrow(ValidationError);
    await expect(provider.generate('image', '   ')).rejects.toThrow(ValidationError);
  });

  it('resolveMediaProvider returns a working provider (mock by default)', async () => {
    const p = resolveMediaProvider();
    const asset = await p.generate('audio', 'ambient waves');
    expect(asset.provider).toBe('mock');
  });
});
