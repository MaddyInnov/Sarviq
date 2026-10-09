// SPDX-License-Identifier: Apache-2.0
// <Pet> — renders a companion pet SVG with a mood-driven CSS animation.
// Props: pet (style id), size (px), mood. No JS animation libraries.

'use client';

import React from 'react';
import { petDef, type PetId, type PetMood } from '../../lib/pet';
import { PET_ART } from './art';

export interface PetProps {
  pet: PetId;
  size?: number;
  mood?: PetMood;
  className?: string;
  /** Accessible label; defaults to the pet's name. */
  label?: string;
}

export function Pet({ pet, size = 48, mood = 'idle', className = '', label }: PetProps) {
  const Art = PET_ART[pet];
  const name = petDef(pet).name;
  return (
    <span
      className={`pet pet-mood-${mood}${className ? ` ${className}` : ''}`}
      data-mood={mood}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `${name} the companion pet (${mood})`}
    >
      <span className="pet-inner">
        <svg className="pet-svg" viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
          <Art mood={mood} />
        </svg>
      </span>
    </span>
  );
}
