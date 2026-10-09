// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SPACE_HEADER, SPACE_STORAGE_KEY, spaceHeaders } from './sarviq-api';

describe('space header helpers', () => {
  it('exposes the stable storage key and header name', () => {
    expect(SPACE_STORAGE_KEY).toBe('sarviq:space');
    expect(SPACE_HEADER).toBe('X-Sarviq-Space');
  });

  it('adds X-Sarviq-Space only when a space id is set', () => {
    expect(spaceHeaders('work')).toEqual({ 'X-Sarviq-Space': 'work' });
    expect(spaceHeaders(null)).toEqual({});
    expect(spaceHeaders('')).toEqual({});
  });

  it('merges extra headers without clobbering them', () => {
    expect(spaceHeaders('work', { 'Content-Type': 'application/json' })).toEqual({
      'X-Sarviq-Space': 'work',
      'Content-Type': 'application/json',
    });
  });
});
