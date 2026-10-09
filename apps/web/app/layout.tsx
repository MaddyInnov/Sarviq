// SPDX-License-Identifier: Apache-2.0
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import './minimal-layout.css';
import './pet.css';
import Nav from './nav';
import PwaInstallBanner from '../components/pwa-install';
import { BrandPet } from '../components/pet/BrandPet';

export const metadata: Metadata = {
  title: 'Sarviq',
  description: 'All-in-one AI agent platform — Sarviq console',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'Sarviq',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#4f46e5',
};

/** Sets html[data-ux] and html[data-theme] before first paint so Simple/Pro choice and theme never flash. */
const UX_INIT_SCRIPT = `try{var m=localStorage.getItem('mvp:ux-mode');document.documentElement.dataset.ux=(m==='pro'?'pro':'simple');}catch(e){document.documentElement.dataset.ux='simple';}`;
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('mvp:theme');var ok=['light','dark','midnight','porcelain','ocean'].indexOf(t)>=0;t=ok?t:'system';var r=t==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;document.documentElement.dataset.theme=r;document.documentElement.dataset.themeChoice=t;}catch(e){document.documentElement.dataset.theme='light';document.documentElement.dataset.themeChoice='system';}`;
/** Classic vs Minimal layout (Octop parity): persisted, no flash. Minimal is the default on small screens. */
const LAYOUT_INIT_SCRIPT = `try{var l=localStorage.getItem('mvp:layout');var ok=['classic','minimal'].indexOf(l)>=0;if(!ok){l=(window.innerWidth||1024)<768?'minimal':'classic';}document.documentElement.dataset.layout=l;}catch(e){document.documentElement.dataset.layout='classic';}`;
/** Registers the PWA service worker (no-op where unsupported). */
const SW_REGISTER_SCRIPT = `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){/* offline/PWA optional */});});}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <script dangerouslySetInnerHTML={{ __html: UX_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LAYOUT_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SW_REGISTER_SCRIPT }} />
      </head>
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              <BrandPet />
              Sarviq
            </Link>
            <Nav />
          </header>
          <main className="main">{children}</main>
        </div>
        <PwaInstallBanner />
      </body>
    </html>
  );
}
