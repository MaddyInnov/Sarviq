// SPDX-License-Identifier: Apache-2.0
// Pure-config tests for the 3D pets (no WebGL needed — Pet3D.tsx's scene
// code only runs in the browser; this covers the static contract).

import { describe, expect, it } from 'vitest';
import { PET3D_CONFIG, PET3D_IDS } from './Pet3D';
import { PETS, type PetId } from '../../lib/pet';

const HEX = /^#[0-9a-f]{6}$/i;

describe('Pet3D config', () => {
  it('covers every pet id exactly once', () => {
    const petIds = PETS.map((p) => p.id).sort();
    expect([...PET3D_IDS].sort()).toEqual(petIds);
    expect(new Set(PET3D_IDS).size).toBe(PET3D_IDS.length);
  });

  it('every pet has valid body/accent hex colors and a description', () => {
    for (const id of PET3D_IDS) {
      const cfg = PET3D_CONFIG[id as PetId];
      expect(cfg, id).toBeDefined();
      expect(cfg.body, `${id} body`).toMatch(HEX);
      expect(cfg.accent, `${id} accent`).toMatch(HEX);
      expect(cfg.description.length, `${id} description`).toBeGreaterThan(8);
    }
  });

  it('body and accent differ per pet (visual identity)', () => {
    for (const id of PET3D_IDS) {
      const cfg = PET3D_CONFIG[id as PetId];
      expect(cfg.body.toLowerCase()).not.toBe(cfg.accent.toLowerCase());
    }
  });
});
