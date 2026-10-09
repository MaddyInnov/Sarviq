// SPDX-License-Identifier: Apache-2.0
// Tiny client component for the topbar brand: the user's chosen pet at 26px.

'use client';

import { usePet } from '../../lib/pet';
import { Pet } from './Pet';

export function BrandPet() {
  const { choice } = usePet();
  return (
    <span className="brand-pet" aria-hidden="true">
      <Pet pet={choice.id} size={26} mood="idle" label="" />
    </span>
  );
}
