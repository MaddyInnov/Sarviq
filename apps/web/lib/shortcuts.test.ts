// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isEditableTarget, matchShortcut, TRIAGE_SHORTCUTS } from './shortcuts';

describe('isEditableTarget', () => {
  it('flags text inputs, textareas and selects as editable', () => {
    expect(isEditableTarget({ tag: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tag: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tag: 'select' })).toBe(true);
  });

  it('flags contenteditable and textbox roles', () => {
    expect(isEditableTarget({ tag: 'div', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tag: 'div', role: 'textbox' })).toBe(true);
  });

  it('lets plain buttons and divs through', () => {
    expect(isEditableTarget({ tag: 'button' })).toBe(false);
    expect(isEditableTarget({ tag: 'div' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe('matchShortcut', () => {
  it('maps the documented single keys', () => {
    expect(matchShortcut({ key: 'r' })).toBe('refresh');
    expect(matchShortcut({ key: 'd' })).toBe('mark-done');
    expect(matchShortcut({ key: 'a' })).toBe('archive');
    expect(matchShortcut({ key: 'x' })).toBe('toggle-select');
    expect(matchShortcut({ key: 'j' })).toBe('focus-next');
    expect(matchShortcut({ key: 'k' })).toBe('focus-prev');
    expect(matchShortcut({ key: 'Escape' })).toBe('close');
    expect(matchShortcut({ key: '?' })).toBe('toggle-help');
  });

  it('ignores modifier combos and unknown keys', () => {
    expect(matchShortcut({ key: 'r', ctrlKey: true })).toBeNull();
    expect(matchShortcut({ key: 'd', metaKey: true })).toBeNull();
    expect(matchShortcut({ key: 'q' })).toBeNull();
  });

  it('documents every shortcut exactly once', () => {
    const keys = TRIAGE_SHORTCUTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(TRIAGE_SHORTCUTS.every((s) => s.label.length > 0)).toBe(true);
  });
});
