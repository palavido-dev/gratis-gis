// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CATALOG_COLLECTION_ID,
  assertRecordsQuery,
  queryPublicRecords,
  bboxesIntersect,
  buildRecord,
  catalogCollectionDoc,
  parseBboxQuery,
  type ItemRow,
} from './records-core.js';

function row(partial: Partial<ItemRow> & Pick<ItemRow, 'id' | 'title'>): ItemRow {
  return {
    description: partial.description ?? partial.title,
    type: partial.type ?? 'data_layer',
    tags: partial.tags ?? [],
    license: partial.license ?? null,
    bbox: partial.bbox ?? null,
    createdAt: partial.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: partial.updatedAt ?? new Date('2026-06-01T00:00:00Z'),
    owner: partial.owner ?? { fullName: 'Pat Mapper', username: 'pat' },
    ...partial,
  };
}

describe('records-core', () => {
  it('exposes a catalog collection with itemType=record', () => {
    const doc = catalogCollectionDoc('http://portal.test/api/public/ogc');
    expect(doc.id).toBe(CATALOG_COLLECTION_ID);
    expect(doc.itemType).toBe('record');
    expect(doc.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rel: 'items',
          href: `http://portal.test/api/public/ogc/collections/${CATALOG_COLLECTION_ID}/items`,
        }),
      ]),
    );
  });

  it('splits curated themes from free-form keywords', () => {
    const rec = buildRecord(
      row({
        id: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Parcels',
        tags: ['Boundaries', 'campus', 'Property'],
      }),
      'http://portal.test',
    );
    const props = rec.properties as {
      keywords: string[];
      themes?: string[];
    };
    expect(props.themes).toEqual(['Boundaries', 'Property']);
    expect(props.keywords).toEqual(['campus']);
  });

  it('emits FILE:GEO enclosure and owner provider on data_layer records', () => {
    const rec = buildRecord(
      row({
        id: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Parcels',
        type: 'data_layer',
        bbox: [-80.2, 39.1, -80.0, 39.3],
      }),
      'http://portal.test',
    );
    const links = rec.links as Array<Record<string, string>>;
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'FILE:GEO',
          rel: 'enclosure',
          href: 'http://portal.test/api/public/ogc/collections/123e4567-e89b-12d3-a456-426614174000/items',
        }),
      ]),
    );
    const props = rec.properties as {
      providers: Array<{ name: string; roles: string[] }>;
    };
    expect(props.providers).toEqual([
      { name: 'Pat Mapper', roles: ['producer'] },
    ]);
    expect(rec.geometry).toEqual(
      expect.objectContaining({ type: 'Polygon' }),
    );
  });

  it('uses catalog self links when mounted under /collections', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const selfPath = `http://portal.test/api/public/ogc/collections/catalog/items/${id}`;
    const rec = buildRecord(
      row({ id, title: 'Parcels' }),
      'http://portal.test',
      { selfPath },
    );
    expect(rec.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel: 'self', href: selfPath }),
      ]),
    );
  });

  it('parses and intersects CRS84 bboxes', () => {
    expect(parseBboxQuery('-80.5,39.0,-80.0,39.5')).toEqual([
      -80.5, 39.0, -80.0, 39.5,
    ]);
    expect(parseBboxQuery('nope')).toBeNull();
    expect(
      bboxesIntersect([-80.2, 39.1, -80.0, 39.3], [-80.5, 39.0, -80.0, 39.5]),
    ).toBe(true);
    expect(
      bboxesIntersect([-70, 30, -69, 31], [-80.5, 39.0, -80.0, 39.5]),
    ).toBe(false);
  });

  it('tests a bbox in SQL and counts the whole match, not a capped scan', async () => {
    const queryRaw = jest.fn(async () => [{ id: '11111111-1111-1111-1111-111111111111' }]);
    const count = jest.fn(async () => 1);
    const findMany = jest.fn(async () => [
      row({ id: '11111111-1111-1111-1111-111111111111', title: 'Inside' }),
    ]);
    const out = await queryPublicRecords(
      { $queryRaw: queryRaw, item: { count, findMany } } as never,
      {
        where: { access: 'public', deletedAt: null },
        orderBy: undefined,
        offset: 0,
        limit: 10,
        bbox: '-80.5,39.0,-80.0,39.5',
      },
    );
    const sql = (queryRaw.mock.calls[0] as unknown as [{ strings: string[]; values: unknown[] }])[0];
    expect(sql.strings.join('?')).toContain('bbox_geom &&');
    expect(sql.values).toEqual([-80.5, 39.0, -80.0, 39.5]);
    const where = (count.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(JSON.stringify(where)).toContain('11111111-1111-1111-1111-111111111111');
    expect(out.total).toBe(1);
    expect((findMany.mock.calls[0] as unknown as [{ take: number }])[0].take).toBe(10);
  });

  it('refuses a filter it cannot apply instead of dropping it', () => {
    expect(() => assertRecordsQuery(['bbox'], { bbox: 'abc', offset: 0 })).toThrow(
      /bbox/,
    );
    expect(() =>
      assertRecordsQuery(['type'], { type: 'not_a_type', offset: 0 }),
    ).toThrow(/Unknown type/);
    expect(() => assertRecordsQuery(['nope'], { offset: 0 })).toThrow(/Unknown query/);
    expect(() => assertRecordsQuery([], { offset: 10_000_000 })).toThrow(/offset/);
    // Any real item type is accepted, including ones the old list missed.
    expect(() =>
      assertRecordsQuery(['type'], { type: 'tile_layer', offset: 0 }),
    ).not.toThrow();
  });
});
