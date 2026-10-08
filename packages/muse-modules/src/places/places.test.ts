// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ValidationError, NotFoundError } from '../errors.js';
import { MockPlaceSearch, mapWidgetPayload, mapWidgetForPlaces } from './index.js';

describe('MockPlaceSearch', () => {
  const search = new MockPlaceSearch();

  it('finds places by name, address, or category', () => {
    expect(search.searchPlaces('coffee')).toHaveLength(2);
    expect(search.searchPlaces('park')).toHaveLength(2);
    expect(search.searchPlaces('bengaluru', { limit: 6 })).toHaveLength(6);
  });

  it('respects the limit and validates input', () => {
    expect(search.searchPlaces('bengaluru', { limit: 2 })).toHaveLength(2);
    expect(() => search.searchPlaces('   ')).toThrow(ValidationError);
    expect(() => search.searchPlaces('x', { limit: 99 })).toThrow(ValidationError);
  });

  it('getPlace resolves fixtures, throws for unknown ids', () => {
    expect(search.getPlace('place-001').name).toBe('Cubbon Park');
    expect(() => search.getPlace('place-999')).toThrow(NotFoundError);
  });
});

describe('map widget payloads', () => {
  const search = new MockPlaceSearch();

  it('mapWidgetPayload centers on the place with one pin', () => {
    const place = search.getPlace('place-001');
    const payload = mapWidgetPayload(place);
    expect(payload.widget).toBe('map');
    expect(payload.version).toBe(1);
    expect(payload.center).toEqual({ lat: place.lat, lng: place.lng });
    expect(payload.pins).toEqual([{ lat: place.lat, lng: place.lng, label: place.name }]);
    expect(payload.zoom).toBe(15);
  });

  it('mapWidgetForPlaces averages pins across results', () => {
    const places = search.searchPlaces('coffee');
    const payload = mapWidgetForPlaces(places);
    expect(payload.pins).toHaveLength(2);
    expect(payload.center.lat).toBeCloseTo((places[0].lat + places[1].lat) / 2);
  });

  it('validates zoom and non-empty input', () => {
    const place = search.getPlace('place-001');
    expect(() => mapWidgetPayload(place, { zoom: 99 })).toThrow(ValidationError);
    expect(() => mapWidgetForPlaces([])).toThrow(ValidationError);
  });
});
