// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  allAgoTypeMappings,
  classifyAgoItems,
  classifyAgoType,
  sortByImportOrder,
} from './type-mapping.js';

describe('classifyAgoType', () => {
  it('maps Web Map to portal map item', () => {
    const m = classifyAgoType('Web Map');
    expect(m.targetType).toBe('map');
    expect(m.supported).toBe(true);
    expect(m.needsDataFetch).toBe(true);
  });

  it('maps Feature Service to service with arcgis_features protocol', () => {
    const m = classifyAgoType('Feature Service');
    expect(m.targetType).toBe('service');
    expect(m.protocol).toBe('arcgis_features');
    expect(m.needsServiceProbe).toBe(true);
    expect(m.supported).toBe(true);
  });

  it('maps Map Service to arcgis_map protocol', () => {
    const m = classifyAgoType('Map Service');
    expect(m.protocol).toBe('arcgis_map');
  });

  it('maps Vector Tile Service to arcgis_vector_tiles protocol', () => {
    const m = classifyAgoType('Vector Tile Service');
    expect(m.protocol).toBe('arcgis_vector_tiles');
  });

  it('flags StoryMap as not supported with an explanation', () => {
    const m = classifyAgoType('StoryMap');
    expect(m.supported).toBe(false);
    expect(m.targetType).toBe('web_app');
    expect(m.notes).toMatch(/not yet supported/);
  });

  it('returns a synthetic unknown row for unrecognized types', () => {
    const m = classifyAgoType('AGO Tea Pot');
    expect(m.targetType).toBeNull();
    expect(m.supported).toBe(false);
    expect(m.notes).toContain('no mapping');
    expect(m.notes).toContain('AGO Tea Pot');
  });

  it('files / docs all land on the file item type', () => {
    for (const t of [
      'Image',
      'PDF',
      'CSV',
      'Microsoft Word',
      'Microsoft Excel',
      'Document Link',
      'Shapefile',
    ]) {
      expect(classifyAgoType(t).targetType).toBe('file');
    }
  });
});

describe('classifyAgoItems', () => {
  it('returns one classification per input item, keyed by id', () => {
    const items = [
      { id: 'a', type: 'Web Map' },
      { id: 'b', type: 'Feature Service' },
      { id: 'c', type: 'AGO Tea Pot' },
    ];
    const map = classifyAgoItems(items);
    expect(map.size).toBe(3);
    expect(map.get('a')?.targetType).toBe('map');
    expect(map.get('b')?.targetType).toBe('service');
    expect(map.get('c')?.targetType).toBeNull();
  });
});

describe('sortByImportOrder', () => {
  it('puts services before maps before web apps', () => {
    const items = [
      { id: 'app', type: 'Web Mapping Application' },
      { id: 'wm', type: 'Web Map' },
      { id: 'svc', type: 'Feature Service' },
    ];
    const sorted = sortByImportOrder(items).map((i) => i.id);
    expect(sorted).toEqual(['svc', 'wm', 'app']);
  });

  it('preserves input order for items of the same type', () => {
    const items = [
      { id: 'svc-1', type: 'Feature Service' },
      { id: 'svc-2', type: 'Map Service' },
      { id: 'svc-3', type: 'Vector Tile Service' },
    ];
    expect(sortByImportOrder(items).map((i) => i.id)).toEqual([
      'svc-1',
      'svc-2',
      'svc-3',
    ]);
  });

  it('puts unknown types last', () => {
    const items = [
      { id: 'wm', type: 'Web Map' },
      { id: 'mystery', type: 'AGO Tea Pot' },
      { id: 'svc', type: 'Feature Service' },
    ];
    const sorted = sortByImportOrder(items).map((i) => i.id);
    expect(sorted[sorted.length - 1]).toBe('mystery');
  });
});

describe('allAgoTypeMappings', () => {
  it('includes every supported type expected on the v1 importer', () => {
    const types = new Set(allAgoTypeMappings().map((m) => m.agoType));
    const required = [
      'Feature Service',
      'Map Service',
      'Vector Tile Service',
      'Web Map',
      'Form',
      'Image',
      'PDF',
      'CSV',
      'Document Link',
    ];
    for (const t of required) {
      expect(types.has(t)).toBe(true);
    }
  });

  it('every row carries a non-empty notes string', () => {
    for (const row of allAgoTypeMappings()) {
      expect(row.notes.length).toBeGreaterThan(0);
    }
  });

  it('every supported row sets a targetType', () => {
    for (const row of allAgoTypeMappings()) {
      if (row.supported) {
        expect(row.targetType).not.toBeNull();
      }
    }
  });

  it('service rows set a protocol; non-service rows do not', () => {
    for (const row of allAgoTypeMappings()) {
      if (row.targetType === 'service') {
        expect(row.protocol).toBeTruthy();
      } else {
        expect(row.protocol).toBeUndefined();
      }
    }
  });
});

describe('mapping matches what the importer does', () => {
  it('does not promise an import for Document Links, which the importer skips', () => {
    expect(classifyAgoType('Document Link').supported).toBe(false);
  });
});
