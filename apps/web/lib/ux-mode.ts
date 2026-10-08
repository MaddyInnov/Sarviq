// SPDX-License-Identifier: Apache-2.0
// Simple/Pro UX mode. Simple = calm: non-essential motion disabled via
// `html[data-ux="simple"]` CSS. Pro = full motion/depth treatment.
// Persisted in localStorage; the root layout sets data-ux before first paint.

'use client';

import { useCallback, useEffect, useState } from 'react';

export type UxMode = 'simple' | 'pro';

const KEY = 'mvp:ux-mode';

export function getStoredUxMode(): UxMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'pro' ? 'pro' : 'simple';
  } catch {
    return 'simple';
  }
}

export function applyUxMode(mode: UxMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.ux = mode;
  }
}

/** React binding for the Simple/Pro toggle. */
export function useUxMode(): [UxMode, (mode: UxMode) => void] {
  const [mode, setModeState] = useState<UxMode>('simple');
  useEffect(() => {
    setModeState(getStoredUxMode());
  }, []);
  const setMode = useCallback((m: UxMode) => {
    applyUxMode(m);
    setModeState(m);
  }, []);
  return [mode, setMode];
}

/** True while the effective mode is calm (simple). Respects prefers-reduced-motion too. */
export function useCalmMotion(): boolean {
  const [mode] = useUxMode();
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mode === 'simple' || reduced;
}
