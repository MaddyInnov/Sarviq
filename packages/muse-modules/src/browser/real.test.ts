// SPDX-License-Identifier: Apache-2.0
// Tests for the real browser driver opt-in wiring.
// Playwright is never loaded: selectBrowserDriver() is env-only, and the
// driver's lazy require is tested for its install error.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PlaywrightBrowserDriver,
  selectBrowserDriver,
  isRealBrowserDriverActive,
  BROWSER_REAL_ENV,
} from './real.js';
import { MockBrowserDriver } from './index.js';
import type { BrowserDriver } from './index.js';

const ENV = process.env as Record<string, string | undefined>;
let saved: string | undefined;

beforeEach(() => {
  saved = ENV[BROWSER_REAL_ENV];
});

afterEach(() => {
  if (saved === undefined) delete ENV[BROWSER_REAL_ENV];
  else ENV[BROWSER_REAL_ENV] = saved;
});

describe('selectBrowserDriver', () => {
  it('returns the mock by default (fail-safe)', () => {
    delete ENV[BROWSER_REAL_ENV];
    expect(selectBrowserDriver()).toBeInstanceOf(MockBrowserDriver);
    expect(isRealBrowserDriverActive()).toBe(false);
  });

  it('returns the mock for any value other than "1"', () => {
    ENV[BROWSER_REAL_ENV] = 'yes';
    expect(selectBrowserDriver()).toBeInstanceOf(MockBrowserDriver);
  });

  it('returns the real Playwright driver when BROWSER_REAL=1', () => {
    ENV[BROWSER_REAL_ENV] = '1';
    const driver = selectBrowserDriver();
    expect(driver).toBeInstanceOf(PlaywrightBrowserDriver);
    expect(isRealBrowserDriverActive()).toBe(true);
    // Real-only capabilities exist on the driver.
    expect(typeof driver.click).toBe('function');
    expect(typeof driver.fill).toBe('function');
    expect(typeof driver.content).toBe('function');
    expect(typeof driver.close).toBe('function');
    // Mock does not implement them.
    const mockAsDriver: BrowserDriver = new MockBrowserDriver();
    expect(mockAsDriver.click).toBeUndefined();
  });

  it('throws a clear install error when playwright is missing', async () => {
    const driver = new PlaywrightBrowserDriver();
    await expect(driver.navigate('https://example.com')).rejects.toThrow(
      /playwright.*not installed/,
    );
  });

  it('rejects non-http(s) URLs before touching playwright', async () => {
    const driver = new PlaywrightBrowserDriver();
    await expect(driver.navigate('file:///etc/passwd')).rejects.toThrow(/http\(s\)/);
  });
});
