// SPDX-License-Identifier: Apache-2.0
// Theme system: Dark / Light / System + signature themes (Midnight Clay,
// Porcelain, Ocean Glass), all in the same claymorphism + glassmorphism
// language. Choice persists in localStorage; the root layout sets
// html[data-theme] before first paint so the theme never flashes.
// "system" resolves to light/dark via prefers-color-scheme and live-updates.

'use client';

import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system' | 'midnight' | 'porcelain' | 'ocean';
/** Resolved themes actually rendered (system folds into light/dark). */
export type ResolvedTheme = 'light' | 'dark' | 'midnight' | 'porcelain' | 'ocean';

export interface ThemeDef {
  id: ThemeChoice;
  label: string;
  hint: string;
  /** Two swatch colors for the picker UI. */
  swatch: [string, string];
}

export const THEMES: ThemeDef[] = [
  { id: 'light', label: 'Light', hint: 'Daylight clay', swatch: ['#f6f4ef', '#4f46e5'] },
  { id: 'dark', label: 'Dark', hint: 'Obsidian clay', swatch: ['#14161c', '#818cf8'] },
  { id: 'system', label: 'System', hint: 'Follows your OS', swatch: ['#f6f4ef', '#14161c'] },
  { id: 'midnight', label: 'Midnight Clay', hint: 'Deep indigo night', swatch: ['#0f1030', '#a78bfa'] },
  { id: 'porcelain', label: 'Porcelain', hint: 'Warm cream ceramic', swatch: ['#faf6ef', '#c2410c'] },
  { id: 'ocean', label: 'Ocean Glass', hint: 'Teal deep-sea glass', swatch: ['#062a33', '#22d3ee'] },
];

const KEY = 'mvp:theme';
const VALID: ThemeChoice[] = ['light', 'dark', 'system', 'midnight', 'porcelain', 'ocean'];

export function getStoredThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return (VALID as string[]).includes(v ?? '') ? (v as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

export function systemIsDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') return systemIsDark() ? 'dark' : 'light';
  return choice;
}

export function applyThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // ignore
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolveTheme(choice);
    document.documentElement.dataset.themeChoice = choice;
  }
}

/** React binding for the theme chooser. Live-updates when the OS theme changes. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void, ResolvedTheme] {
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('light');

  useEffect(() => {
    const c = getStoredThemeChoice();
    setChoiceState(c);
    setResolved(resolveTheme(c));
    applyThemeChoice(c);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const cur = getStoredThemeChoice();
      setResolved(resolveTheme(cur));
      if (cur === 'system') applyThemeChoice(cur);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setChoice = useCallback((c: ThemeChoice) => {
    applyThemeChoice(c);
    setChoiceState(c);
    setResolved(resolveTheme(c));
  }, []);

  return [choice, setChoice, resolved];
}
