// SPDX-License-Identifier: Apache-2.0
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import Nav from './nav';

export const metadata: Metadata = {
  title: 'MVP Console',
  description: 'All-in-one AI agent platform — MVP console',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/** Sets html[data-ux] before first paint so Simple/Pro choice never flashes. */
const UX_INIT_SCRIPT = `try{var m=localStorage.getItem('mvp:ux-mode');document.documentElement.dataset.ux=(m==='pro'?'pro':'simple');}catch(e){document.documentElement.dataset.ux='simple';}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: UX_INIT_SCRIPT }} />
      </head>
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              Agent<span> · MVP</span>
            </Link>
            <Nav />
          </header>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
