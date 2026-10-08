// SPDX-License-Identifier: Apache-2.0
import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import Nav from './nav';

export const metadata: Metadata = {
  title: 'MVP Console',
  description: 'All-in-one AI agent platform — MVP console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
