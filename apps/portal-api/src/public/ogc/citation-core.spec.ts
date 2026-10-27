// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildBibTeX,
  buildJsonLd,
  buildRis,
  citationParts,
  filenameFor,
} from './citation-core.js';

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'County Parcels',
  description: 'Tax parcels for the county.',
  type: 'data_layer' as const,
  tags: ['Boundaries', 'parcels'],
  license: 'CC-BY-4.0',
  bbox: [-93.5, 44.5, -93.0, 45.0],
  createdAt: new Date('2026-03-01T12:00:00.000Z'),
  updatedAt: new Date('2026-03-02T12:00:00.000Z'),
  owner: { fullName: 'Ada Lovelace', username: 'ada' },
  org: { name: 'Demo Org' },
};

describe('citation builders', () => {
  it('builds BibTeX with author, year, and portal url', () => {
    const bib = buildBibTeX(baseRow, 'https://example.test');
    expect(bib).toContain('@dataset{CountyParcels2026,');
    expect(bib).toContain('author = {Ada Lovelace}');
    expect(bib).toContain('year = {2026}');
    expect(bib).toContain(
      'url = {https://example.test/items/11111111-1111-4111-8111-111111111111}',
    );
    expect(bib).toContain('copyright = {CC-BY-4.0}');
    expect(bib.endsWith('}\n')).toBe(true);
  });

  it('builds RIS with DATA type and ER terminator', () => {
    const ris = buildRis(baseRow, 'https://example.test');
    expect(ris.startsWith('TY  - DATA\n')).toBe(true);
    expect(ris).toContain('TI  - County Parcels');
    expect(ris).toContain('AU  - Ada Lovelace');
    expect(ris).toContain('UR  - https://example.test/items/');
    expect(ris.trimEnd().endsWith('ER  -')).toBe(true);
  });

  it('builds Schema.org Dataset JSON-LD', () => {
    const doc = buildJsonLd(baseRow, 'https://example.test');
    expect(doc['@type']).toBe('Dataset');
    expect(doc.name).toBe('County Parcels');
    expect(doc.identifier).toBe(baseRow.id);
    expect((doc.creator as { name: string }).name).toBe('Ada Lovelace');
    expect((doc.publisher as { name: string }).name).toBe('Demo Org');
    expect(doc.license).toBe('CC-BY-4.0');
  });

  it('falls back to org or GratisGIS when owner is missing', () => {
    const p = citationParts(
      { ...baseRow, owner: null },
      'https://example.test',
    );
    expect(p.author).toBe('Demo Org');
    const p2 = citationParts(
      { ...baseRow, owner: null, org: null },
      'https://example.test',
    );
    expect(p2.author).toBe('GratisGIS');
  });

  it('maps map items to misc / MAP / Map', () => {
    const mapRow = { ...baseRow, type: 'map' as const };
    expect(buildBibTeX(mapRow, 'https://example.test')).toContain('@misc{');
    expect(buildRis(mapRow, 'https://example.test')).toContain('TY  - MAP');
    expect(buildJsonLd(mapRow, 'https://example.test')['@type']).toBe('Map');
  });

  it('suggests download filenames from the title slug', () => {
    expect(filenameFor(baseRow, 'bibtex')).toBe('CountyParcels.bib');
    expect(filenameFor(baseRow, 'ris')).toBe('CountyParcels.ris');
    expect(filenameFor(baseRow, 'jsonld')).toBe('CountyParcels.jsonld');
  });

  it('escapes BibTeX special characters in titles', () => {
    const bib = buildBibTeX(
      { ...baseRow, title: 'Flood & Fire {risk}' },
      'https://example.test',
    );
    expect(bib).toContain('\\&');
    expect(bib).toContain('\\{risk\\}');
  });
});
