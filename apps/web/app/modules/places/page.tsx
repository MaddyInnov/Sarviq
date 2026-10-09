// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { MODULES_BASE, api, PageHeader, ErrorBox, EmptyState } from '../lib';

interface Place {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
  rating: number;
}

interface MapWidgetPayload {
  widget: 'map';
  version: 1;
  center: { lat: number; lng: number };
  zoom: number;
  pins: { lat: number; lng: number; label: string }[];
}

/** Simple SVG pin-map: plots pins relative to the payload center. */
function PinMap({ payload }: { payload: MapWidgetPayload }): React.ReactElement {
  const W = 560;
  const H = 300;
  const lats = payload.pins.map((p) => p.lat);
  const lngs = payload.pins.map((p) => p.lng);
  const minLat = Math.min(...lats, payload.center.lat);
  const maxLat = Math.max(...lats, payload.center.lat);
  const minLng = Math.min(...lngs, payload.center.lng);
  const maxLng = Math.max(...lngs, payload.center.lng);
  const spanLat = Math.max(maxLat - minLat, 0.001);
  const spanLng = Math.max(maxLng - minLng, 0.001);
  const x = (lng: number) => 30 + ((lng - minLng) / spanLng) * (W - 60);
  const y = (lat: number) => 30 + ((maxLat - lat) / spanLat) * (H - 60);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', borderRadius: 12, background: 'var(--surface-2)' }}>
      {payload.pins.map((p, i) => (
        <g key={i}>
          <circle cx={x(p.lng)} cy={y(p.lat)} r={10} fill="var(--accent)" opacity={0.9} />
          <text x={x(p.lng) + 14} y={y(p.lat) + 4} fontSize={12} fill="var(--text)">
            {p.label}
          </text>
        </g>
      ))}
      <circle cx={x(payload.center.lng)} cy={y(payload.center.lat)} r={5} fill="var(--red)" />
    </svg>
  );
}

export default function PlacesPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Place | null>(null);
  const [map, setMap] = useState<MapWidgetPayload | null>(null);

  const search = async () => {
    setBusy(true);
    setError('');
    try {
      const r = (await api(`${MODULES_BASE}/places/search?q=${encodeURIComponent(query)}`)) as Place[];
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openPlace = async (id: string) => {
    try {
      const p = (await api(`${MODULES_BASE}/places/${id}`)) as Place;
      setSelected(p);
      const m = (await api(`${MODULES_BASE}/places/${id}/map`)) as MapWidgetPayload;
      setMap(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <PageHeader title="Places" sub="Search places, view details and a pin map." />
      <ErrorBox error={error} />

      <div className="card">
        <div className="row-between">
          <input
            className="input"
            style={{ flex: 1, marginRight: 8 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search places (e.g. coffee, park)…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <button className="btn" disabled={busy} onClick={() => void search()}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      <div className="grid-2 mt">
        <div>
          {results.map((p) => (
            <div className={`card${selected?.id === p.id ? ' active' : ''}`} key={p.id}>
              <div className="row-between">
                <strong>{p.name}</strong>
                <span className="small muted">★ {p.rating.toFixed(1)}</span>
              </div>
              <p className="small muted mt">
                {p.address} · {p.category}
              </p>
              <div className="mt">
                <button className="btn btn-sm" onClick={() => void openPlace(p.id)}>
                  View
                </button>
              </div>
            </div>
          ))}
          {results.length === 0 && <EmptyState text="Search for a place to begin." />}
        </div>

        <div>
          {selected ? (
            <div className="card">
              <div className="row-between">
                <strong>{selected.name}</strong>
                <button className="btn btn-sm" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <p className="small muted mt">{selected.address}</p>
              <p className="small muted">
                {selected.category} · ★ {selected.rating.toFixed(1)} · {selected.lat.toFixed(4)},{' '}
                {selected.lng.toFixed(4)}
              </p>
              {map && (
                <div className="mt">
                  <PinMap payload={map} />
                </div>
              )}
            </div>
          ) : (
            <EmptyState text="Select a place to see details and the map." />
          )}
        </div>
      </div>
    </div>
  );
}
