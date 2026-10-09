// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parsePublicBaseUrl } from '../src/config.js';

describe('parsePublicBaseUrl', () => {
  it('accepts a clean https URL', () => {
    expect(parsePublicBaseUrl('https://sarviq.example.com')).toBe('https://sarviq.example.com');
  });

  it('strips trailing slashes', () => {
    expect(parsePublicBaseUrl('https://sarviq.example.com///')).toBe('https://sarviq.example.com');
  });

  it('lowercases scheme and host but keeps the path', () => {
    expect(parsePublicBaseUrl('HTTPS://Sarviq.Example.COM/app')).toBe('https://sarviq.example.com/app');
  });

  it('keeps an explicit port', () => {
    expect(parsePublicBaseUrl('https://sarviq.example.com:8443')).toBe('https://sarviq.example.com:8443');
  });

  it('accepts http (with a cleartext warning) so LAN tunnels still work', () => {
    expect(parsePublicBaseUrl('http://192.168.1.5:4000')).toBe('http://192.168.1.5:4000');
  });

  it('rejects missing or malformed values', () => {
    expect(parsePublicBaseUrl(undefined)).toBeUndefined();
    expect(parsePublicBaseUrl('')).toBeUndefined();
    expect(parsePublicBaseUrl('   ')).toBeUndefined();
    expect(parsePublicBaseUrl('not-a-url')).toBeUndefined();
    expect(parsePublicBaseUrl('ftp://x.example.com')).toBeUndefined();
    expect(parsePublicBaseUrl('https://')).toBeUndefined();
    expect(parsePublicBaseUrl('https://exa mple.com')).toBeUndefined();
  });
});

describe('loadConfig SARVIQ_PUBLIC_URL', () => {
  const OLD = process.env.SARVIQ_PUBLIC_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SARVIQ_PUBLIC_URL;
    else process.env.SARVIQ_PUBLIC_URL = OLD;
  });

  it('exposes publicBaseUrl from the environment', () => {
    process.env.SARVIQ_PUBLIC_URL = 'https://sarviq.example.com/';
    expect(loadConfig().publicBaseUrl).toBe('https://sarviq.example.com');
  });

  it('is undefined when the env var is absent', () => {
    delete process.env.SARVIQ_PUBLIC_URL;
    expect(loadConfig().publicBaseUrl).toBeUndefined();
  });
});
