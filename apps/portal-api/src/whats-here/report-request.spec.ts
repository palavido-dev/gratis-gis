// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { MAX_REPORT_LAYERS, parseReportRequest, REPORT_LABEL_KEYS } from './report-request.js';

const labels = Object.fromEntries(REPORT_LABEL_KEYS.map((k) => [k, k.toUpperCase()]));
const ITEM = '11111111-2222-4333-8444-555555555555';
const base = () => ({
  areaId: 'a'.repeat(32),
  distanceMeters: 152.4,
  layers: [{ itemId: ITEM, layerKey: 'parcels', title: 'Parcels', breakdownField: 'zoning' }],
  areaUnit: 'acres',
  lengthUnit: 'feet',
  labels,
});

describe('parseReportRequest (#796)', () => {
  it('accepts a full request and fills defaults', () => {
    const r = parseReportRequest(base());
    expect(r.paper).toBe('letter');
    expect(r.locale).toBe('en-US');
    expect(r.picked).toEqual([]);
    expect(r.timeZone).toBe('UTC');
    expect(r.layers[0]).toEqual({ itemId: ITEM, layerKey: 'parcels', title: 'Parcels', breakdownField: 'zoning' });
    expect(r.labels.title).toBe('TITLE');
  });

  it('keeps a PNG or JPEG map picture and refuses anything else', () => {
    expect(parseReportRequest({ ...base(), mapImage: 'data:image/jpeg;base64,AAAA' }).mapImage).toBeDefined();
    for (const bad of ['data:image/svg+xml;base64,AAAA', 'https://x.test/a.png', 'data:image/png;base64,AA"><script>']) {
      expect(() => parseReportRequest({ ...base(), mapImage: bad })).toThrow(BadRequestException);
    }
  });

  it.each([
    ['a non-object', null],
    ['a bad area id', { ...base(), areaId: 'nope' }],
    ['a negative distance', { ...base(), distanceMeters: -1 }],
    ['no layers', { ...base(), layers: [] }],
    ['too many layers', { ...base(), layers: Array(MAX_REPORT_LAYERS + 1).fill(base().layers[0]) }],
    ['a non-uuid item', { ...base(), layers: [{ ...base().layers[0], itemId: 'x' }] }],
    ['a field with SQL in it', { ...base(), layers: [{ ...base().layers[0], breakdownField: "a'); drop" }] }],
    ['an unknown unit', { ...base(), areaUnit: 'furlongs' }],
    ['an unknown paper', { ...base(), paper: 'legal' }],
    ['a bad locale', { ...base(), locale: '../../etc' }],
    ['an unknown time zone', { ...base(), timeZone: 'Mars/Olympus' }],
    ['a missing label', { ...base(), labels: { ...labels, title: undefined } }],
    ['a non-text picked name', { ...base(), picked: [3] }],
  ])('refuses %s', (_name, body) => {
    expect(() => parseReportRequest(body)).toThrow(BadRequestException);
  });
});
