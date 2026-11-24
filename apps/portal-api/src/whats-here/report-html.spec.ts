// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatArea, formatLength, renderWhatsHereReport, type ReportDoc } from './report-html.js';
import { REPORT_LABEL_KEYS } from './report-request.js';

const labels = Object.fromEntries(REPORT_LABEL_KEYS.map((k) => [k, `[${k}]`])) as ReportDoc['labels'];
const ACRE = 4046.8564224;

function doc(over: Partial<ReportDoc> = {}): ReportDoc {
  return {
    title: 'Site screen',
    generatedAt: new Date('2026-11-24T18:00:00Z'),
    locale: 'en-US',
    timeZone: 'America/Los_Angeles',
    labels,
    areaSquareMeters: 100 * ACRE,
    distanceMeters: 0,
    picked: [],
    areaUnit: 'acres',
    lengthUnit: 'feet',
    layers: [],
    ...over,
  };
}

describe('What’s Here report HTML (#796)', () => {
  it('formats units with fewer decimals as numbers grow', () => {
    expect(formatArea(0.42 * ACRE, 'acres', 'en-US')).toBe('0.42 ac');
    expect(formatArea(1204 * ACRE, 'acres', 'en-US')).toBe('1,204 ac');
    expect(formatArea(25_000, 'hectares', 'en-US')).toBe('2.5 ha');
    expect(formatLength(1609.344, 'miles', 'en-US')).toBe('1 mi');
    expect(formatLength(1500, 'kilometers', 'de-DE')).toBe('1,5 km');
  });

  it('puts found layers in the table, empty ones on one line, unreadable ones apart', () => {
    const html = renderWhatsHereReport(
      doc({
        layers: [
          { title: 'Wetlands', geometry: 'polygon', total: { value: null, count: 3, measure: 25 * ACRE } },
          { title: 'Trails', geometry: 'line', total: { value: null, count: 2, measure: 1609.344 } },
          { title: 'Wells', geometry: 'point', total: { value: null, count: 0, measure: null } },
          { title: 'Secret', geometry: null },
        ],
      }),
    );
    expect(html).toContain('<td>Wetlands</td>');
    expect(html).toContain('25 ac');
    expect(html).toContain('25%');
    expect(html).toContain('5,280 ft');
    expect(html).toContain('[nothingIn] Wells');
    expect(html).not.toContain('<td>Wells</td>');
    expect(html).toContain('[unavailable] Secret');
  });

  it('caps the share of the area at 100%', () => {
    const html = renderWhatsHereReport(
      doc({ layers: [{ title: 'Overlaps', geometry: 'polygon', total: { value: null, count: 9, measure: 300 * ACRE } }] }),
    );
    expect(html).toContain('100%');
    expect(html).not.toContain('300%');
  });

  it('prints a breakdown with labels, an empty value and the truncation note', () => {
    const html = renderWhatsHereReport(
      doc({
        layers: [
          {
            title: 'Parcels',
            geometry: 'polygon',
            total: { value: null, count: 4, measure: 60 * ACRE },
            breakdown: {
              fieldLabel: 'Zoning',
              truncated: true,
              rows: [
                { value: 'Residential', count: 3, measure: 50 * ACRE },
                { value: null, count: 1, measure: 10 * ACRE },
              ],
            },
          },
        ],
      }),
    );
    expect(html).toContain('Parcels · [breakdownBy] Zoning');
    expect(html).toContain('<td>Residential</td>');
    expect(html).toContain('<em>[noValue]</em>');
    expect(html).toContain('[truncated]');
  });

  it('says "only inside" for no distance, and the distance otherwise', () => {
    expect(renderWhatsHereReport(doc())).toContain('[onlyInside]');
    expect(renderWhatsHereReport(doc({ distanceMeters: 152.4 }))).toContain('500 ft');
  });

  it('escapes everything that came from a user or the data', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderWhatsHereReport(
      doc({
        title: evil,
        place: evil,
        picked: [evil],
        layers: [
          {
            title: evil,
            geometry: 'polygon',
            total: { value: null, count: 1, measure: 1 },
            breakdown: { fieldLabel: evil, truncated: false, rows: [{ value: evil, count: 1, measure: 1 }] },
          },
        ],
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('prints the made time in the caller\'s zone', () => {
    // 18:00 UTC is 10:00 in Los Angeles in November.
    expect(renderWhatsHereReport(doc())).toMatch(/10:00\s?AM/);
  });

  it('prints added-up fields under the layer and as breakdown columns', () => {
    const html = renderWhatsHereReport(
      doc({
        labels: { ...labels, totalOf: 'Total {label}' },
        layers: [
          {
            title: 'Parcels',
            geometry: 'polygon',
            sumLabels: ['Assessed value', 'Units'],
            total: { value: null, count: 2, measure: 10 * ACRE, sums: [1250000.5, null] },
            breakdown: {
              fieldLabel: 'Zoning',
              truncated: false,
              rows: [{ value: 'R1', count: 2, measure: 10 * ACRE, sums: [1250000.5, null] }],
            },
          },
        ],
      }),
    );
    expect(html).toContain('Total Assessed value 1,250,000.5 · Total Units –');
    expect(html).toContain('<th class="n">Total Units</th>');
    expect(html).toContain('[sumNote]');
  });

  it('embeds the map picture only when given', () => {
    expect(renderWhatsHereReport(doc())).not.toContain('<img');
    expect(renderWhatsHereReport(doc({ mapImage: 'data:image/png;base64,AAAA' }))).toContain(
      '<img class="map" src="data:image/png;base64,AAAA"',
    );
  });
});
