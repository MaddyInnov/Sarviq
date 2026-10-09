// SPDX-License-Identifier: Apache-2.0
// REAL browser driver — foreground control of a real Chromium via Playwright.
//
// SAFETY: never selected by default. selectBrowserDriver() returns the mock
// unless BROWSER_REAL=1 is set. Every action still flows through the
// BrowserAutomation request → approve → execute pipeline (approval-gated,
// audited) — the driver swap changes WHAT executes, not WHETHER approval
// is required.
//
// Playwright is an OPTIONAL dependency, lazy-loaded on first use, so the
// module imports cleanly without it. Install + fetch a browser:
//   npm install playwright
//   npx playwright install chromium
// Set BROWSER_REAL=1 to opt in. PLAYWRIGHT_HEADED=1 opens a visible window
// (default is headless).

import { MockBrowserDriver } from './index.js';
import type { BrowserDriver, NavigateResult } from './index.js';

// This package compiles to CommonJS, so bare require() is available at
// runtime. The playwright require is lazy (inside loadPlaywright) so the
// module imports cleanly without playwright installed.
declare const require: NodeRequire;

/** Env var that opts into the REAL browser driver. Mock is the default. */
export const BROWSER_REAL_ENV = 'BROWSER_REAL';

interface PlaywrightPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  textContent(selector: string): Promise<string | null>;
  screenshot(opts?: { type?: string }): Promise<Buffer>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launch(opts?: { headless?: boolean; timeout?: number }): Promise<PlaywrightBrowser>;
}

function loadPlaywright(): { chromium: PlaywrightChromium } {
  try {
    return require('playwright') as { chromium: PlaywrightChromium };
  } catch (err) {
    throw new Error(
      'BROWSER_REAL=1 is set but the "playwright" package is not installed. ' +
        'Install it and fetch Chromium: npm install playwright && npx playwright install chromium. ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function requireHttpUrl(url: string): string {
  if (!/^https?:\/\//i.test(url.trim())) {
    throw new Error('browser driver requires an http(s) URL');
  }
  return url.trim();
}

export interface PlaywrightDriverOptions {
  /** Override headed/headless (default: headless unless PLAYWRIGHT_HEADED=1). */
  headless?: boolean;
  /** Navigation/action timeout ms. */
  timeoutMs?: number;
}

/**
 * Real foreground browser driver backed by Playwright Chromium.
 * One browser + one page, reused across actions; close() releases them.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private browser: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;
  private readonly headless: boolean;
  private readonly timeoutMs: number;

  constructor(opts: PlaywrightDriverOptions = {}) {
    this.headless =
      opts.headless ?? process.env['PLAYWRIGHT_HEADED'] !== '1';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page;
    const { chromium } = loadPlaywright();
    try {
      this.browser = await chromium.launch({ headless: this.headless, timeout: this.timeoutMs });
    } catch (err) {
      throw new Error(
        'Playwright could not launch Chromium. ' +
          'Run: npx playwright install chromium. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.page = await this.browser.newPage();
    return this.page;
  }

  async navigate(url: string): Promise<NavigateResult> {
    const target = requireHttpUrl(url);
    const page = await this.ensurePage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    return { url: page.url(), title: await page.title() };
  }

  async extractText(): Promise<string> {
    const page = await this.ensurePage();
    return (await page.textContent('body')) ?? '';
  }

  async screenshot(): Promise<Uint8Array> {
    const page = await this.ensurePage();
    const buf = await page.screenshot({ type: 'png' });
    return new Uint8Array(buf);
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector, { timeout: this.timeoutMs });
  }

  async fill(selector: string, text: string): Promise<void> {
    const page = await this.ensurePage();
    await page.fill(selector, text, { timeout: this.timeoutMs });
  }

  async content(): Promise<string> {
    const page = await this.ensurePage();
    return page.content();
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => undefined);
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}

/**
 * Select the browser driver: PlaywrightBrowserDriver only when
 * BROWSER_REAL=1, otherwise the safe MockBrowserDriver.
 */
export function selectBrowserDriver(): BrowserDriver {
  if (process.env[BROWSER_REAL_ENV] === '1') {
    return new PlaywrightBrowserDriver();
  }
  return new MockBrowserDriver();
}

/** True when the real browser driver is active (for status endpoints). */
export function isRealBrowserDriverActive(): boolean {
  return process.env[BROWSER_REAL_ENV] === '1';
}
