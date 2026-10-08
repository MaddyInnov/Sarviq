// SPDX-License-Identifier: Apache-2.0
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getApiBase } from '../lib/api';

const LINKS = [
  { href: '/', label: 'Chat' },
  { href: '/bots', label: 'Bots' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/workflows', label: 'Workflows' },
  { href: '/audit', label: 'Audit' },
  { href: '/providers', label: 'Providers' },
];

export default function Nav() {
  const pathname = usePathname();
  const [apiBase, setApiBase] = useState('');
  useEffect(() => {
    setApiBase(getApiBase() || '(same origin)');
  }, []);
  return (
    <>
      {LINKS.map((l) => {
        const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={`navlink${active ? ' active' : ''}`}>
            {l.label}
          </Link>
        );
      })}
      <div className="spacer" />
      <span className="api-base" title="API base URL">
        api: {apiBase}
      </span>
    </>
  );
}
