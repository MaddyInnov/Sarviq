// SPDX-License-Identifier: Apache-2.0
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getApiBase } from '../lib/api';
import { useUxMode, type UxMode } from '../lib/ux-mode';
import { THEMES, useTheme, type ThemeChoice } from '../lib/theme';

interface Dest {
  href: string;
  label: string;
  match: (p: string) => boolean;
  icon: React.ReactNode;
}

function icon(path: React.ReactNode) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const DESTS: Dest[] = [
  {
    href: '/',
    label: 'Chat',
    match: (p) => p === '/',
    icon: icon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />),
  },
  {
    href: '/bots',
    label: 'Bots',
    match: (p) => p.startsWith('/bots'),
    icon: icon(
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M9 9h.01M15 9h.01M8 14h8" />
      </>,
    ),
  },
  {
    href: '/workflows',
    label: 'Workflows',
    match: (p) => p.startsWith('/workflows'),
    icon: icon(
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <path d="M8.5 6H15M6 8.5v7M6 15.5h7.5" />
      </>,
    ),
  },
  {
    href: '/marketplace',
    label: 'Marketplace',
    match: (p) => p.startsWith('/marketplace'),
    icon: icon(
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>,
    ),
  },
  {
    href: '/workspace',
    label: 'Workspace',
    match: (p) => p.startsWith('/workspace') || p.startsWith('/notes') || p.startsWith('/tasks'),
    icon: icon(
      <>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </>,
    ),
  },
  {
    href: '/activity',
    label: 'Activity',
    match: (p) => p.startsWith('/activity') || p.startsWith('/approvals') || p.startsWith('/audit'),
    icon: icon(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />),
  },
];

const SETTINGS_LINKS = [
  { href: '/accounts', label: 'Accounts & API keys' },
  { href: '/providers', label: 'Providers & models' },
  { href: '/more', label: 'Modules hub' },
];

function ModeToggle({ mode, onChange }: { mode: UxMode; onChange: (m: UxMode) => void }) {
  return (
    <div
      className="mode-toggle"
      role="group"
      aria-label="Interface mode"
      title="Simple: calm, no extra motion. Pro: full animation and depth."
    >
      <button
        className={`mode-opt${mode === 'simple' ? ' active' : ''}`}
        onClick={() => onChange('simple')}
        aria-pressed={mode === 'simple'}
      >
        Simple
      </button>
      <button
        className={`mode-opt${mode === 'pro' ? ' active' : ''}`}
        onClick={() => onChange('pro')}
        aria-pressed={mode === 'pro'}
      >
        Pro
      </button>
    </div>
  );
}

/** Theme chooser: Dark / Light / System + signature clay themes. */
function ThemeSwitcher() {
  const [choice, setChoice] = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = THEMES.find((t) => t.id === choice) ?? THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const pick = (c: ThemeChoice) => {
    setChoice(c);
    setOpen(false);
  };

  return (
    <div className="theme-wrap" ref={ref}>
      <button
        className="theme-btn"
        aria-label={`Theme: ${active.label}. Change theme`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Change theme"
      >
        <span
          className="swatch-dot"
          style={{ background: `linear-gradient(135deg, ${active.swatch[0]} 50%, ${active.swatch[1]} 50%)` }}
          aria-hidden="true"
        />
        {active.label}
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-opt${t.id === choice ? ' active' : ''}`}
              role="menuitemradio"
              aria-checked={t.id === choice}
              onClick={() => pick(t.id)}
            >
              <span className="swatches" aria-hidden="true">
                <span className="swatch-dot" style={{ background: t.swatch[0] }} />
                <span className="swatch-dot" style={{ background: t.swatch[1] }} />
              </span>
              <span className="tmeta">
                <span className="tname">{t.label}</span>
                <br />
                <span className="thint">{t.hint}</span>
              </span>
              {t.id === choice && <span className="tcheck" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Nav() {
  const pathname = usePathname();
  const [apiBase, setApiBase] = useState('');
  const [mode, setMode] = useUxMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setApiBase(getApiBase() || '(same origin)');
  }, []);

  // Close the settings menu on outside click / Escape, and the drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  return (
    <>
      {/* Desktop / wide nav links */}
      <nav className="dest-nav" aria-label="Primary">
        {DESTS.map((d) => (
          <Link key={d.href} href={d.href} className={`navlink${d.match(pathname) ? ' active' : ''}`}>
            <span className="navlink-icon">{d.icon}</span>
            {d.label}
          </Link>
        ))}
      </nav>

      {/* Hamburger: mobile only */}
      <button
        className="hamburger"
        aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen((v) => !v)}
      >
        <span />
        <span />
        <span />
      </button>

      <div className="spacer" />
      <span className="api-base" title="API base URL">
        api: {apiBase}
      </span>
      <ThemeSwitcher />
      <ModeToggle mode={mode} onChange={setMode} />

      {/* Settings menu (accounts, providers, modules hub) */}
      <div className="settings-wrap" ref={settingsRef}>
        <button
          className="icon-btn"
          aria-label="Settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {settingsOpen && (
          <div className="settings-menu" role="menu">
            {SETTINGS_LINKS.map((s) => (
              <Link key={s.href} href={s.href} role="menuitem" onClick={() => setSettingsOpen(false)}>
                {s.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <button className="drawer-scrim" aria-label="Close menu" onClick={() => setDrawerOpen(false)} />
      )}
      <aside className={`drawer${drawerOpen ? ' open' : ''}`} aria-label="Menu" aria-hidden={!drawerOpen}>
        <div className="drawer-head">
          <span className="brand-mini">
            Agent<span> · MVP</span>
          </span>
          <button className="icon-btn" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>
            ✕
          </button>
        </div>
        <nav className="drawer-nav" aria-label="Primary">
          {DESTS.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              className={`drawer-link${d.match(pathname) ? ' active' : ''}`}
              onClick={() => setDrawerOpen(false)}
            >
              <span className="navlink-icon">{d.icon}</span>
              {d.label}
            </Link>
          ))}
        </nav>
        <div className="drawer-section">Settings</div>
        {SETTINGS_LINKS.map((s) => (
          <Link key={s.href} href={s.href} className="drawer-link" onClick={() => setDrawerOpen(false)}>
            {s.label}
          </Link>
        ))}
        <div className="drawer-section">Theme</div>
        <div className="drawer-theme">
          <ThemeSwitcher />
        </div>
        <div className="drawer-section">Mode</div>
        <div className="drawer-mode">
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      </aside>

      {/* Mobile bottom tab bar: the 6 destinations, thumb-friendly */}
      <nav className="mobile-tabs" aria-label="Primary">
        {DESTS.map((d) => (
          <Link key={d.href} href={d.href} className={`mtab${d.match(pathname) ? ' active' : ''}`}>
            <span className="navlink-icon">{d.icon}</span>
            <span className="mtab-label">{d.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
