// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { en, hi, type Strings } from './locales';
import { getStoredLocale, setStoredLocale, useI18n, LanguageSwitcher, LOCALES } from './i18n';

/** Recursively collect dot-path keys of a string table. */
function keysOf(obj: object, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') out.push(...keysOf(v, path));
    else out.push(path);
  }
  return out.sort();
}

describe('locale dictionaries', () => {
  it('ships exactly the en + hi locales', () => {
    expect(LOCALES.map((l) => l.id).sort()).toEqual(['en', 'hi']);
  });

  it('hi has exactly the same key set as en (source of truth)', () => {
    expect(keysOf(hi)).toEqual(keysOf(en));
  });

  it('every value is a non-empty string', () => {
    for (const key of keysOf(en)) {
      let cur: unknown = en;
      for (const part of key.split('.')) cur = (cur as Record<string, unknown>)[part];
      expect(typeof cur, key).toBe('string');
      expect((cur as string).length, key).toBeGreaterThan(0);
    }
  });

  it('covers the six top-level destination labels', () => {
    const nav = (en as Strings).nav;
    expect(Object.keys(nav).sort()).toEqual(
      ['activity', 'bots', 'chat', 'marketplace', 'workflows', 'workspace'],
    );
  });
});

function Probe({ k, vars }: { k: string; vars?: Record<string, string | number> }) {
  const { t } = useI18n();
  return React.createElement('span', null, t(k, vars));
}

describe('useI18n without a provider (English fallback)', () => {
  it('translates a known key', () => {
    expect(renderToStaticMarkup(React.createElement(Probe, { k: 'chat.send' }))).toContain('Send');
  });

  it('interpolates {vars}', () => {
    const html = renderToStaticMarkup(
      React.createElement(Probe, { k: 'chat.composerPlaceholder', vars: { bot: 'Aria' } }),
    );
    expect(html).toContain('Aria');
    expect(html).not.toContain('{bot}');
  });

  it('falls back to the key itself for unknown keys', () => {
    expect(renderToStaticMarkup(React.createElement(Probe, { k: 'nope.missing' }))).toContain(
      'nope.missing',
    );
  });
});

describe('locale persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it('defaults to en and round-trips hi', () => {
    expect(getStoredLocale()).toBe('en');
    setStoredLocale('hi');
    expect(getStoredLocale()).toBe('hi');
  });

  it('rejects unknown stored values', () => {
    (globalThis as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      'mvp:locale',
      'xx',
    );
    expect(getStoredLocale()).toBe('en');
  });
});

describe('LanguageSwitcher', () => {
  it('renders both locale options', () => {
    const html = renderToStaticMarkup(React.createElement(LanguageSwitcher));
    expect(html).toContain('value="en"');
    expect(html).toContain('value="hi"');
    expect(html).toContain('हिन्दी');
    expect(html).toContain('aria-label="Language"');
  });
});
