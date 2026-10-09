// SPDX-License-Identifier: Apache-2.0
'use client';

import { useMemo } from 'react';

export interface GraphNode {
  id: string;
  title: string;
  linkCount: number;
  tags: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
}

/** Deterministic hue from a tag string (for node coloring). */
function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * 2D knowledge graph rendered as SVG (no heavy deps). Layout: nodes placed
 * on concentric rings by link count (most-connected toward center), angles
 * spread deterministically by id hash. Nodes sized by linkCount, colored by
 * first tag. Click a node to open the note.
 */
export function GraphView({ nodes, edges, selectedId, onSelect }: Props) {
  const W = 720;
  const H = 520;
  const cx = W / 2;
  const cy = H / 2;

  const layout = useMemo(() => {
    if (nodes.length === 0) return new Map<string, { x: number; y: number }>();
    const sorted = [...nodes].sort((a, b) => b.linkCount - a.linkCount || a.title.localeCompare(b.title));
    const pos = new Map<string, { x: number; y: number }>();
    // Most-connected node goes dead center.
    pos.set(sorted[0].id, { x: cx, y: cy });
    const rest = sorted.slice(1);
    const rings = 3;
    rest.forEach((n, i) => {
      const ring = Math.min(rings - 1, Math.floor((i / Math.max(1, rest.length)) * rings));
      const radius = 110 + ring * 95;
      // Deterministic angle from id hash + golden-angle spread within ring.
      let hash = 0;
      for (let k = 0; k < n.id.length; k++) hash = (hash * 33 + n.id.charCodeAt(k)) >>> 0;
      const inRing = rest.filter(
        (_, j) => Math.min(rings - 1, Math.floor((j / Math.max(1, rest.length)) * rings)) === ring,
      );
      const slot = inRing.findIndex((x) => x.id === n.id);
      const angle = ((hash % 360) / 360) * Math.PI * 2 + (slot / Math.max(1, inRing.length)) * Math.PI * 2;
      pos.set(n.id, {
        x: cx + Math.cos(angle) * radius * 1.35,
        y: cy + Math.sin(angle) * radius * 0.85,
      });
    });
    return pos;
  }, [nodes]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="knowledge-graph"
      role="img"
      aria-label="Knowledge graph"
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      {edges.map((e, i) => {
        const a = layout.get(e.from);
        const b = layout.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className="kg-edge"
          />
        );
      })}
      {nodes.map((n) => {
        const p = layout.get(n.id);
        if (!p) return null;
        const r = 10 + Math.min(18, n.linkCount * 3);
        const selected = n.id === selectedId;
        const tag = n.tags[0];
        const fill = tag ? `hsl(${tagHue(tag)} 55% 62%)` : undefined;
        return (
          <g
            key={n.id}
            transform={`translate(${p.x},${p.y})`}
            onClick={() => onSelect(n.id)}
            className={`kg-node${selected ? ' selected' : ''}`}
            style={{ cursor: 'pointer' }}
          >
            <circle r={r} fill={fill} className="kg-circle" />
            <text
              y={r + 14}
              textAnchor="middle"
              className="kg-label"
            >
              {n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title}
            </text>
          </g>
        );
      })}
      {nodes.length === 0 && (
        <text x={cx} y={cy} textAnchor="middle" className="kg-label">
          No notes yet — create one to grow your graph.
        </text>
      )}
    </svg>
  );
}
