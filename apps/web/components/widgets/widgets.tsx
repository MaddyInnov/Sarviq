// SPDX-License-Identifier: Apache-2.0
// In-chat widget renderers. The registry maps each WidgetKind to its view;
// WidgetRenderer dispatches. Pure SVG charts — no chart dependencies.

'use client';

import { useState } from 'react';
import {
  cellText,
  formatBytes,
  type ActionsWidget,
  type ChartWidget,
  type FileWidget,
  type MapWidget,
  type TableWidget,
  type Widget,
  type WidgetAction,
  type WidgetKind,
  WIDGET_KINDS,
} from './schema';

export type WidgetActionHandler = (action: WidgetAction, widget: ActionsWidget) => void | Promise<void>;

const KIND_LABEL: Record<WidgetKind, string> = {
  table: 'table',
  chart: 'chart',
  actions: 'actions',
  map: 'place',
  file: 'file',
};

/* ---------- table ---------- */

function TableView({ widget }: { widget: TableWidget }) {
  return (
    <div className="widget-table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {widget.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {widget.rows.map((row, i) => (
            <tr key={i}>
              {widget.columns.map((c, j) => (
                <td key={j} className={typeof row[j] === 'number' ? 'mono' : undefined}>
                  {cellText(row[j])}
                </td>
              ))}
            </tr>
          ))}
          {widget.rows.length === 0 && (
            <tr>
              <td colSpan={widget.columns.length} className="muted">
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- chart (SVG, no deps) ---------- */

const CHART_COLORS = ['#4f46e5', '#16a34a', '#d97706', '#dc2626', '#0ea5e9', '#8b5cf6'];
const CW = 420;
const CH = 240;
const PAD = { l: 40, r: 12, t: 14, b: 34 };

function chartScales(widget: ChartWidget) {
  const all = widget.datasets.flatMap((d) => d.values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const span = max - min || 1;
  const iw = CW - PAD.l - PAD.r;
  const ih = CH - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (iw * (i + 0.5)) / widget.labels.length;
  const y = (v: number) => PAD.t + ih - ((v - min) / span) * ih;
  return { x, y, iw, ih, min, max };
}

function ChartView({ widget }: { widget: ChartWidget }) {
  const { x, y, iw } = chartScales(widget);
  const n = widget.labels.length;
  const slot = iw / n;
  if (widget.chart === 'bar') {
    const per = Math.min(28, (slot * 0.7) / widget.datasets.length);
    const groupW = per * widget.datasets.length;
    return (
      <>
        <svg className="widget-chart" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={widget.title ?? 'Bar chart'}>
          {widget.labels.map((l, i) => (
            <text key={i} x={x(i)} y={CH - 10} textAnchor="middle" fontSize="10" fill="#a1a1aa">
              {l.length > 12 ? `${l.slice(0, 11)}…` : l}
            </text>
          ))}
          {widget.datasets.map((d, di) =>
            d.values.map((v, i) => {
              const bx = x(i) - groupW / 2 + di * per;
              const by = y(v);
              const zeroY = y(0);
              return (
                <rect
                  key={`${di}-${i}`}
                  x={bx}
                  y={Math.min(by, zeroY)}
                  width={Math.max(2, per - 3)}
                  height={Math.max(2, Math.abs(zeroY - by))}
                  rx="2"
                  fill={CHART_COLORS[di % CHART_COLORS.length]}
                >
                  <title>{`${d.label} · ${widget.labels[i]}: ${v}`}</title>
                </rect>
              );
            }),
          )}
        </svg>
        <ChartLegend widget={widget} />
      </>
    );
  }
  // line
  return (
    <>
      <svg className="widget-chart" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={widget.title ?? 'Line chart'}>
        {widget.datasets.map((d, di) => {
          const pts = d.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
          const color = CHART_COLORS[di % CHART_COLORS.length];
          const area = `${PAD.l},${y(0)} ${pts} ${PAD.l + iw},${y(0)}`;
          return (
            <g key={di}>
              <polygon points={area} fill={color} opacity="0.12" />
              <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              {d.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={color} stroke="#fff" strokeWidth="1.5">
                  <title>{`${d.label} · ${widget.labels[i]}: ${v}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {widget.labels.map((l, i) => (
          <text key={i} x={x(i)} y={CH - 10} textAnchor="middle" fontSize="10" fill="#a1a1aa">
            {l.length > 12 ? `${l.slice(0, 11)}…` : l}
          </text>
        ))}
      </svg>
      <ChartLegend widget={widget} />
    </>
  );
}

function ChartLegend({ widget }: { widget: ChartWidget }) {
  if (widget.datasets.length < 2) return null;
  return (
    <div className="widget-chart-legend">
      {widget.datasets.map((d, i) => (
        <span key={i}>
          <span className="swatch" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
          {d.label}
        </span>
      ))}
    </div>
  );
}

/* ---------- actions ---------- */

function ActionsView({
  widget,
  onAction,
}: {
  widget: ActionsWidget;
  onAction?: WidgetActionHandler;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const click = async (a: WidgetAction) => {
    if (!onAction || busyId) return;
    setBusyId(a.id);
    try {
      await onAction(a, widget);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="widget-actions">
      {widget.buttons.map((b) => {
        const cls =
          b.style === 'primary' ? 'btn btn-primary' : b.style === 'danger' ? 'btn btn-danger' : 'btn';
        return (
          <button
            key={b.id}
            className={`${cls}${busyId === b.id ? ' busy' : ''}`}
            onClick={() => void click(b)}
            disabled={!onAction || busyId !== null}
            title={onAction ? undefined : 'No action handler wired'}
          >
            {busyId === b.id ? 'Working…' : b.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- map / place placeholder ---------- */

function MapView({ widget }: { widget: MapWidget }) {
  const q =
    widget.query ??
    (widget.lat !== undefined && widget.lng !== undefined
      ? `${widget.lat},${widget.lng}`
      : undefined);
  const mapsUrl = q
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
    : undefined;
  return (
    <div className="widget-map">
      <div className="map-pin" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </div>
      <div>
        <div style={{ fontWeight: 650 }}>{widget.label ?? widget.query ?? 'Pinned place'}</div>
        <div className="small muted">
          {widget.lat !== undefined && widget.lng !== undefined
            ? `${widget.lat.toFixed(4)}, ${widget.lng.toFixed(4)}`
            : widget.query}
        </div>
        {mapsUrl && (
          <a className="small" href={mapsUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Open in Maps →
          </a>
        )}
      </div>
    </div>
  );
}

/* ---------- file ---------- */

function FileView({ widget }: { widget: FileWidget }) {
  return (
    <div className="widget-file">
      <div className="file-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {widget.name}
        </div>
        <div className="small muted">
          {widget.mime ? `${widget.mime} · ` : ''}
          {widget.size !== undefined ? formatBytes(widget.size) : 'size unknown'}
        </div>
        {widget.url && (
          <a className="small" href={widget.url} download={widget.name} style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Download →
          </a>
        )}
      </div>
    </div>
  );
}

/* ---------- registry ---------- */

/** Kind → view component registry. Views receive the validated widget as `widget`. */
export const WIDGET_REGISTRY: Record<
  WidgetKind,
  (props: { widget: Widget; onAction?: WidgetActionHandler }) => React.ReactElement
> = {
  table: ({ widget }) => <TableView widget={widget as TableWidget} />,
  chart: ({ widget }) => <ChartView widget={widget as ChartWidget} />,
  actions: ({ widget, onAction }) => <ActionsView widget={widget as ActionsWidget} onAction={onAction} />,
  map: ({ widget }) => <MapView widget={widget as MapWidget} />,
  file: ({ widget }) => <FileView widget={widget as FileWidget} />,
};

/** All kinds the registry can render (should mirror schema's WIDGET_KINDS). */
export function registeredWidgetKinds(): WidgetKind[] {
  return [...WIDGET_KINDS].filter((k) => k in WIDGET_REGISTRY);
}

export function WidgetRenderer({
  widget,
  onAction,
}: {
  widget: Widget;
  onAction?: WidgetActionHandler;
}) {
  const View = WIDGET_REGISTRY[widget.kind];
  if (!View) return null;
  return (
    <div className="widget" data-widget-kind={widget.kind}>
      <div className="widget-head">
        <span className="widget-kind">{KIND_LABEL[widget.kind]}</span>
        {widget.title && <span className="truncate">{widget.title}</span>}
      </div>
      <div className="widget-body">
        <View widget={widget} onAction={onAction} />
      </div>
    </div>
  );
}
