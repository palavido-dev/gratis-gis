// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('client CSV export', () => {
  // The formula guard lives in shared-types csvCell (tested there).
  // The client export used to quote cells itself and skip it.
  it('writes every cell through csvCell', () => {
    const src = readFileSync(join(__dirname, 'layer-export.ts'), 'utf8');
    expect(src).toMatch(/return csvCell\(v\);/);
    expect(src).not.toMatch(/replace\(\/"\/g, '""'\)/);
  });
});
