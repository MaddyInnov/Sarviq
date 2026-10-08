// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  WIDGET_KINDS,
  cellText,
  formatBytes,
  validateWidget,
} from './schema';
import { WIDGET_REGISTRY, registeredWidgetKinds } from './widgets';

describe('validateWidget', () => {
  it('rejects non-objects and unknown kinds', () => {
    for (const bad of [null, 42, 'table', [], { kind: 'carousel' }, {}]) {
      const r = validateWidget(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('validates a table and normalizes object rows to column order', () => {
    const r = validateWidget({
      kind: 'table',
      title: 'Plans',
      columns: ['plan', 'price'],
      rows: [
        { plan: 'Free', price: 0 },
        ['Pro', 20],
      ],
      extra: 'stripped',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget.kind).toBe('table');
    expect(r.widget.title).toBe('Plans');
    if (r.widget.kind !== 'table') return;
    expect(r.widget.rows).toEqual([
      ['Free', 0],
      ['Pro', 20],
    ]);
    expect('extra' in r.widget).toBe(false);
  });

  it('rejects tables with empty columns or bad rows', () => {
    expect(validateWidget({ kind: 'table', columns: [], rows: [] }).ok).toBe(false);
    expect(validateWidget({ kind: 'table', columns: ['a'] }).ok).toBe(false);
    expect(validateWidget({ kind: 'table', columns: ['a'], rows: [42] }).ok).toBe(false);
  });

  it('caps table size', () => {
    const cols = Array.from({ length: 60 }, (_, i) => `c${i}`);
    expect(validateWidget({ kind: 'table', columns: cols, rows: [] }).ok).toBe(false);
    const rows = Array.from({ length: 600 }, () => ['x']);
    expect(validateWidget({ kind: 'table', columns: ['a'], rows }).ok).toBe(false);
  });

  it('validates bar and line charts, requiring one value per label', () => {
    const good = {
      kind: 'chart',
      chart: 'bar',
      labels: ['Jan', 'Feb'],
      datasets: [{ label: 'MRR', values: [10, 20] }],
    };
    expect(validateWidget(good).ok).toBe(true);
    expect(validateWidget({ ...good, chart: 'line' }).ok).toBe(true);
    expect(
      validateWidget({ ...good, datasets: [{ label: 'MRR', values: [10] }] }).ok,
    ).toBe(false);
    expect(
      validateWidget({ ...good, datasets: [{ label: 'MRR', values: [10, NaN] }] }).ok,
    ).toBe(false);
    expect(validateWidget({ ...good, chart: 'pie' }).ok).toBe(false);
    expect(validateWidget({ ...good, labels: [] }).ok).toBe(false);
  });

  it('validates action buttons with style and endpoint defaults', () => {
    const r = validateWidget({
      kind: 'actions',
      buttons: [
        { id: 'run', label: 'Run it', style: 'primary', endpoint: '/api/x', payload: { a: 1 } },
        { id: 'skip', label: 'Skip' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'actions') return;
    expect(r.widget.buttons[0]).toMatchObject({
      id: 'run',
      label: 'Run it',
      style: 'primary',
      endpoint: '/api/x',
      payload: { a: 1 },
    });
    expect(r.widget.buttons[1].style).toBe('default');
    expect(r.widget.buttons[1].endpoint).toBeUndefined();
    expect(validateWidget({ kind: 'actions', buttons: [] }).ok).toBe(false);
    expect(validateWidget({ kind: 'actions', buttons: [{ id: 'x' }] }).ok).toBe(false);
  });

  it('validates map widgets with query or coordinates', () => {
    expect(validateWidget({ kind: 'map', query: 'Connaught Place, New Delhi' }).ok).toBe(true);
    const r = validateWidget({ kind: 'map', lat: 28.63, lng: 77.21, label: 'CP' });
    expect(r.ok).toBe(true);
    expect(validateWidget({ kind: 'map' }).ok).toBe(false);
    expect(validateWidget({ kind: 'map', lat: 999 }).ok).toBe(false);
    expect(validateWidget({ kind: 'map', query: 'x', lng: 200 }).ok).toBe(false);
  });

  it('validates file widgets', () => {
    const r = validateWidget({ kind: 'file', name: 'report.pdf', size: 1048576, mime: 'application/pdf' });
    expect(r.ok).toBe(true);
    expect(validateWidget({ kind: 'file' }).ok).toBe(false);
    expect(validateWidget({ kind: 'file', name: 'x', size: -1 }).ok).toBe(false);
  });

  it('strips unknown fields instead of passing them through', () => {
    const r = validateWidget({
      kind: 'file',
      name: 'a.txt',
      onclick: 'alert(1)',
      title: 'ok',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('onclick' in r.widget).toBe(false);
      expect(r.widget.title).toBe('ok');
    }
  });
});

describe('widget registry', () => {
  it('covers every schema kind', () => {
    expect(registeredWidgetKinds().sort()).toEqual([...WIDGET_KINDS].sort());
    for (const k of WIDGET_KINDS) {
      expect(typeof WIDGET_REGISTRY[k]).toBe('function');
    }
  });
});

describe('helpers', () => {
  it('formatBytes renders human sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('cellText stringifies values safely', () => {
    expect(cellText(null)).toBe('—');
    expect(cellText(undefined)).toBe('—');
    expect(cellText(42)).toBe('42');
    expect(cellText('hi')).toBe('hi');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});
