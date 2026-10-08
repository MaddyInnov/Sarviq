// SPDX-License-Identifier: Apache-2.0
// Places (Muse parity): place search over mock geo data plus a maps widget
// payload (lat/lng + pin) shaped for the chat widget renderer.
// Real geocoding/places providers (founder input: MAPS_API_KEY — see
// workstream-e.md) implement the same PlaceSearch interface.

import { ValidationError, NotFoundError } from '../errors.js';

export interface Place {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
  rating: number;
}

/**
 * Widget payload the chat UI renders as an embedded map. `widget: 'map'`
 * selects the renderer; `pins` marks the places on it.
 */
export interface MapWidgetPayload {
  widget: 'map';
  version: 1;
  center: { lat: number; lng: number };
  zoom: number;
  pins: { lat: number; lng: number; label: string }[];
}

export interface PlaceSearch {
  searchPlaces(query: string, opts?: { limit?: number }): Place[];
  getPlace(id: string): Place;
}

/** Mock geo fixture — deterministic, offline. */
const FIXTURES: Place[] = [
  { id: 'place-001', name: 'Cubbon Park', address: 'Kasturba Rd, Bengaluru, Karnataka', lat: 12.9763, lng: 77.5929, category: 'park', rating: 4.5 },
  { id: 'place-002', name: 'Blue Tokai Coffee Roasters', address: 'Indiranagar, Bengaluru, Karnataka', lat: 12.9784, lng: 77.6408, category: 'cafe', rating: 4.6 },
  { id: 'place-003', name: 'National Gallery of Modern Art', address: 'Palace Rd, Bengaluru, Karnataka', lat: 12.9827, lng: 77.5891, category: 'museum', rating: 4.4 },
  { id: 'place-004', name: 'Toit Brewpub', address: 'Indiranagar, Bengaluru, Karnataka', lat: 12.9783, lng: 77.6401, category: 'restaurant', rating: 4.3 },
  { id: 'place-005', name: 'Lalbagh Botanical Garden', address: 'Mavalli, Bengaluru, Karnataka', lat: 12.9507, lng: 77.5848, category: 'park', rating: 4.6 },
  { id: 'place-006', name: 'Third Wave Coffee', address: 'Koramangala, Bengaluru, Karnataka', lat: 12.9352, lng: 77.6245, category: 'cafe', rating: 4.5 },
];

export class MockPlaceSearch implements PlaceSearch {
  searchPlaces(query: string, opts: { limit?: number } = {}): Place[] {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) throw new ValidationError('place search "query" must be a non-empty string');
    const limit = opts.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ValidationError('place search "limit" must be an integer 1–20');
    }
    const hits = FIXTURES.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.address.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
    return hits.slice(0, limit);
  }

  getPlace(id: string): Place {
    const p = FIXTURES.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`unknown place: ${id}`);
    return p;
  }
}

/** Build a chat-widget map payload centered on the place with one pin. */
export function mapWidgetPayload(place: Place, opts: { zoom?: number } = {}): MapWidgetPayload {
  const zoom = opts.zoom ?? 15;
  if (!Number.isInteger(zoom) || zoom < 1 || zoom > 20) {
    throw new ValidationError('map "zoom" must be an integer 1–20');
  }
  return {
    widget: 'map',
    version: 1,
    center: { lat: place.lat, lng: place.lng },
    zoom,
    pins: [{ lat: place.lat, lng: place.lng, label: place.name }],
  };
}

/** Multi-pin variant for search results. */
export function mapWidgetForPlaces(places: Place[]): MapWidgetPayload {
  if (places.length === 0) throw new ValidationError('need at least one place for a map widget');
  const lat = places.reduce((s, p) => s + p.lat, 0) / places.length;
  const lng = places.reduce((s, p) => s + p.lng, 0) / places.length;
  return {
    widget: 'map',
    version: 1,
    center: { lat, lng },
    zoom: 13,
    pins: places.map((p) => ({ lat: p.lat, lng: p.lng, label: p.name })),
  };
}
