// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildAardvark, resourceClassFor } from './aardvark-core.js';

describe('buildAardvark', () => {
  const baseRow = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Parcels',
    description: 'County parcels',
    type: 'data_layer' as const,
    tags: ['Boundaries', 'Property', 'parcels'],
    license: 'CC-BY-4.0',
    bbox: [-93.5, 44.5, -93.0, 45.0],
    createdAt: new Date('2026-01-15T12:00:00.000Z'),
    updatedAt: new Date('2026-01-16T12:00:00.000Z'),
    owner: { fullName: 'Ada', username: 'ada' },
    org: { name: 'Demo Org' },
  };

  it('emits curated themes and free-form keywords separately', () => {
    const doc = buildAardvark(baseRow, 'https://example.test');
    expect(doc.dcat_theme_sm).toEqual(['Boundaries', 'Property']);
    expect(doc.dcat_keyword_sm).toEqual(['parcels']);
    expect(doc.dct_accessRights_s).toBe('Public');
    expect(doc.dct_title_s).toBe('Parcels');
    expect(doc.schema_provider_s).toBe('Demo Org');
    expect(doc.gbl_resourceClass_sm).toEqual(['Datasets']);
    expect(doc.dcat_bbox).toBe('ENVELOPE(-93.5,-93,45,44.5)');
    expect(doc.dcat_centroid).toBe('44.75,-93.25');
    expect(doc.dct_issued_s).toBe('2026-01-15');
    const refs = JSON.parse(String(doc.dct_references_s)) as Record<
      string,
      string
    >;
    expect(refs['http://schema.org/url']).toBe(
      'https://example.test/items/11111111-1111-4111-8111-111111111111',
    );
    expect(refs['http://schema.org/downloadUrl']).toContain(
      '/api/public/ogc/collections/',
    );
  });

  it('omits theme and keyword fields when empty', () => {
    const doc = buildAardvark(
      { ...baseRow, tags: [], license: null, bbox: [] },
      'https://example.test',
    );
    expect(doc.dcat_theme_sm).toBeUndefined();
    expect(doc.dcat_keyword_sm).toBeUndefined();
    expect(doc.dct_license_sm).toBeUndefined();
    expect(doc.dcat_bbox).toBeUndefined();
  });

  it('maps item types into Aardvark resource classes', () => {
    expect(resourceClassFor('map')).toEqual(['Maps']);
    expect(resourceClassFor('wms_service')).toEqual(['Web services']);
    expect(resourceClassFor('form')).toEqual(['Other']);
  });
});
