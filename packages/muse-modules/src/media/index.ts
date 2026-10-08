// SPDX-License-Identifier: Apache-2.0
// Media generation hooks (Muse parity).
//
// - MediaProvider: interface for image / video / audio generation. Real
//   providers are configured with API keys via environment variables (see
//   docs/founder-setup.d/workstream-e.md); no keys are hardcoded here.
// - MockMediaProvider: deterministic offline provider returning fixture
//   bytes/URLs. Used in tests and as the default until the founder supplies
//   provider credentials.
//
// Zero paid usage in testing: the mock makes no network calls.

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  prompt: string;
  /** Where the bytes live: mock://… for the mock provider, https://… for real ones. */
  url: string;
  mimeType: string;
  /** Byte length of the fixture payload (0 when the provider returns a URL only). */
  byteLength: number;
  provider: string;
}

export interface MediaProvider {
  readonly name: string;
  generate(kind: MediaKind, prompt: string): Promise<MediaAsset>;
}

/** 1×1 transparent PNG fixture bytes (base64). */
const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MIME: Record<MediaKind, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/wav',
};

const EXT: Record<MediaKind, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'wav',
};

/**
 * Deterministic mock provider: returns fixture bytes (a real 1×1 PNG for
 * images) addressed by mock:// URLs. No network, no cost.
 */
export class MockMediaProvider implements MediaProvider {
  readonly name = 'mock';

  async generate(kind: MediaKind, prompt: string): Promise<MediaAsset> {
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
      throw new ValidationError(`media kind must be one of: image, video, audio (got "${kind}")`);
    }
    const p = (prompt ?? '').trim();
    if (!p) throw new ValidationError('media "prompt" must be a non-empty string');
    if (p.length > 2000) throw new ValidationError('media "prompt" must be at most 2000 characters');
    const id = randomUUID();
    const byteLength = kind === 'image' ? Buffer.from(FIXTURE_PNG_BASE64, 'base64').length : 0;
    return {
      id,
      kind,
      prompt: p,
      url: `mock://media/${id}.${EXT[kind]}`,
      mimeType: MIME[kind],
      byteLength,
      provider: this.name,
    };
  }

  /** The raw fixture bytes behind mock image assets. */
  fixtureImageBytes(): Buffer {
    return Buffer.from(FIXTURE_PNG_BASE64, 'base64');
  }
}

/**
 * Resolve the configured media provider. Today this always returns the mock;
 * when the founder supplies provider credentials (env vars, see
 * docs/founder-setup.d/workstream-e.md) this becomes the seam where a real
 * provider is constructed. Never throws for missing keys — it falls back to
 * the mock so the MVP works out of the box.
 */
export function resolveMediaProvider(): MediaProvider {
  return new MockMediaProvider();
}
