// SPDX-License-Identifier: Apache-2.0
// In-chat widget schema + validation.
//
// A widget is a small JSON payload the agent can stream inside chat
// (`{ "type": "widget", "widget": { "kind": "table", ... } }`) to render a
// rich card inline. Validation is strict on shape but forgiving on extras:
// unknown fields are stripped, never passed through to the DOM.
//
// This module is pure TypeScript (no React) so it can be unit-tested and
// shared between the stream handler and the renderer.

export const WIDGET_KINDS = ['table', 'chart', 'actions', 'map', 'file'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export interface WidgetBase {
  kind: WidgetKind;
  /** Optional card heading. */
  title?: string;
}

export interface TableWidget extends WidgetBase {
  kind: 'table';
  columns: string[];
  /**
   * Rows in column order. The validator normalizes object-shaped rows
   * (`{col: value}`) into arrays, so views only handle arrays.
   */
  rows: Array<Array<unknown>>;
}

export interface ChartDataset {
  label: string;
  values: number[];
}

export interface ChartWidget extends WidgetBase {
  kind: 'chart';
  chart: 'bar' | 'line';
  labels: string[];
  datasets: ChartDataset[];
}

export interface WidgetAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger' | 'default';
  /**
   * POST target for the action, resolved against the API base
   * (e.g. "/api/workflows/abc/run"). Defaults to "/api/widget-action".
   */
  endpoint?: string;
  payload?: Record<string, unknown>;
}

export interface ActionsWidget extends WidgetBase {
  kind: 'actions';
  buttons: WidgetAction[];
}

export interface MapWidget extends WidgetBase {
  kind: 'map';
  /** Free-text place query, e.g. "Connaught Place, New Delhi". */
  query?: string;
  lat?: number;
  lng?: number;
  label?: string;
}

export interface FileWidget extends WidgetBase {
  kind: 'file';
  name: string;
  /** Size in bytes. */
  size?: number;
  mime?: string;
  /** Download href. */
  url?: string;
}

export type Widget = TableWidget | ChartWidget | ActionsWidget | MapWidget | FileWidget;

export type WidgetValidation =
  | { ok: true; widget: Widget }
  | { ok: false; error: string };

// Hard caps keep a malicious/buggy payload from blowing up the chat UI.
const MAX_COLUMNS = 50;
const MAX_ROWS = 500;
const MAX_LABELS = 200;
const MAX_DATASETS = 12;
const MAX_BUTTONS = 10;
const MAX_STR = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, cap = MAX_STR): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, cap) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fail(error: string): WidgetValidation {
  return { ok: false, error };
}

function baseOf(raw: Record<string, unknown>, kind: WidgetKind): WidgetBase {
  const title = str(raw.title);
  return title !== undefined ? { kind, title } : { kind };
}

function validateTable(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'table');
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
    return fail('table widget requires a non-empty "columns" array');
  }
  if (raw.columns.length > MAX_COLUMNS) return fail(`table widget allows at most ${MAX_COLUMNS} columns`);
  const columns: string[] = [];
  for (const c of raw.columns) {
    const s = str(c, 120);
    if (s === undefined) return fail('table widget "columns" must be non-empty strings');
    columns.push(s);
  }
  if (!Array.isArray(raw.rows)) return fail('table widget requires a "rows" array');
  if (raw.rows.length > MAX_ROWS) return fail(`table widget allows at most ${MAX_ROWS} rows`);
  const rows: Array<Array<unknown>> = [];
  for (const r of raw.rows) {
    if (Array.isArray(r)) {
      rows.push(r.slice(0, columns.length));
    } else if (isRecord(r)) {
      rows.push(columns.map((c) => r[c]));
    } else {
      return fail('table widget "rows" must be objects or arrays');
    }
  }
  return { ok: true, widget: { ...base, kind: 'table', columns, rows } };
}

function validateChart(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'chart');
  const chart = raw.chart === 'bar' || raw.chart === 'line' ? raw.chart : undefined;
  if (!chart) return fail('chart widget requires "chart": "bar" | "line"');
  if (!Array.isArray(raw.labels) || raw.labels.length === 0) {
    return fail('chart widget requires a non-empty "labels" array');
  }
  if (raw.labels.length > MAX_LABELS) return fail(`chart widget allows at most ${MAX_LABELS} labels`);
  const labels: string[] = [];
  for (const l of raw.labels) {
    const s = str(l, 80);
    if (s === undefined) return fail('chart widget "labels" must be non-empty strings');
    labels.push(s);
  }
  if (!Array.isArray(raw.datasets) || raw.datasets.length === 0) {
    return fail('chart widget requires a non-empty "datasets" array');
  }
  if (raw.datasets.length > MAX_DATASETS) {
    return fail(`chart widget allows at most ${MAX_DATASETS} datasets`);
  }
  const datasets: ChartDataset[] = [];
  for (const d of raw.datasets) {
    if (!isRecord(d)) return fail('chart widget "datasets" must be objects');
    const label = str(d.label, 80);
    if (label === undefined) return fail('chart dataset requires a "label" string');
    if (!Array.isArray(d.values) || d.values.length !== labels.length) {
      return fail(
        `chart dataset "${label}" must have exactly ${labels.length} values (one per label)`,
      );
    }
    const values: number[] = [];
    for (const v of d.values) {
      const n = num(v);
      if (n === undefined) return fail(`chart dataset "${label}" values must be finite numbers`);
      values.push(n);
    }
    datasets.push({ label, values });
  }
  return { ok: true, widget: { ...base, kind: 'chart', chart, labels, datasets } };
}

function validateActions(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'actions');
  if (!Array.isArray(raw.buttons) || raw.buttons.length === 0) {
    return fail('actions widget requires a non-empty "buttons" array');
  }
  if (raw.buttons.length > MAX_BUTTONS) return fail(`actions widget allows at most ${MAX_BUTTONS} buttons`);
  const buttons: WidgetAction[] = [];
  for (const b of raw.buttons) {
    if (!isRecord(b)) return fail('actions widget "buttons" must be objects');
    const id = str(b.id, 80);
    const label = str(b.label, 80);
    if (id === undefined || label === undefined) {
      return fail('actions widget buttons require "id" and "label" strings');
    }
    const style = b.style === 'primary' || b.style === 'danger' ? b.style : 'default';
    const btn: WidgetAction = { id, label, style };
    const endpoint = str(b.endpoint, 300);
    if (endpoint !== undefined) btn.endpoint = endpoint;
    if (isRecord(b.payload)) btn.payload = b.payload;
    buttons.push(btn);
  }
  return { ok: true, widget: { ...base, kind: 'actions', buttons } };
}

function validateMap(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'map');
  const w: MapWidget = { ...base, kind: 'map' };
  const query = str(raw.query);
  if (query !== undefined) w.query = query;
  const label = str(raw.label);
  if (label !== undefined) w.label = label;
  const lat = raw.lat === undefined ? undefined : num(raw.lat);
  const lng = raw.lng === undefined ? undefined : num(raw.lng);
  if (raw.lat !== undefined && lat === undefined) return fail('map widget "lat" must be a finite number');
  if (raw.lng !== undefined && lng === undefined) return fail('map widget "lng" must be a finite number');
  if (lat !== undefined && (lat < -90 || lat > 90)) return fail('map widget "lat" must be between -90 and 90');
  if (lng !== undefined && (lng < -180 || lng > 180)) {
    return fail('map widget "lng" must be between -180 and 180');
  }
  if (lat !== undefined) w.lat = lat;
  if (lng !== undefined) w.lng = lng;
  if (query === undefined && lat === undefined) {
    return fail('map widget needs at least a "query" or coordinates');
  }
  return { ok: true, widget: w };
}

function validateFile(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'file');
  const name = str(raw.name, 200);
  if (name === undefined) return fail('file widget requires a "name" string');
  const w: FileWidget = { ...base, kind: 'file', name };
  const size = raw.size === undefined ? undefined : num(raw.size);
  if (raw.size !== undefined && (size === undefined || size < 0)) {
    return fail('file widget "size" must be a non-negative number');
  }
  if (size !== undefined) w.size = Math.floor(size);
  const mime = str(raw.mime, 120);
  if (mime !== undefined) w.mime = mime;
  const url = str(raw.url, 2000);
  if (url !== undefined) w.url = url;
  return { ok: true, widget: w };
}

/**
 * Validate an untrusted widget payload from the stream.
 * Returns the sanitized widget (unknown fields stripped) or an error.
 */
export function validateWidget(payload: unknown): WidgetValidation {
  if (!isRecord(payload)) return fail('widget payload must be an object');
  const kind = payload.kind;
  if (typeof kind !== 'string' || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    return fail(`unknown widget kind: ${JSON.stringify(kind)} (expected one of ${WIDGET_KINDS.join(', ')})`);
  }
  switch (kind as WidgetKind) {
    case 'table':
      return validateTable(payload);
    case 'chart':
      return validateChart(payload);
    case 'actions':
      return validateActions(payload);
    case 'map':
      return validateMap(payload);
    case 'file':
      return validateFile(payload);
  }
}

/** Human-readable byte size for the file widget. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Render a cell value as text (table widget). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '—';
  } catch {
    return '—';
  }
}
