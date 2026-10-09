// SPDX-License-Identifier: Apache-2.0
// Lazy 3D hero — dynamic import keeps three.js out of the initial bundle.
'use client';

import dynamic from 'next/dynamic';

const ClayScene = dynamic(() => import('./ClayScene'), { ssr: false });

export default function LazyClayScene({ className }: { className?: string }) {
  return <ClayScene className={className} />;
}
