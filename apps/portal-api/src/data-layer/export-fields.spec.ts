// SPDX-License-Identifier: AGPL-3.0-or-later
import { deriveExportFields } from './export-fields.js';

async function* batches(
  ...pages: Array<Array<{ properties?: unknown }>>
): AsyncGenerator<Array<{ properties?: unknown }>> {
  for (const p of pages) yield p;
}

describe('deriveExportFields (06-16)', () => {
  it('lists every key in first-seen order with a type from the values', async () => {
    const fields = await deriveExportFields(
      batches(
        [
          { properties: { name: 'a', count: 1 } },
          { properties: { count: 2, open: true, note: null } },
        ],
        [{ properties: { name: 'b', count: 'n/a', open: false, extra: 3 } }],
      ),
    );
    expect(fields).toEqual([
      { name: 'name', label: 'name', type: 'string' },
      // A text value in a number column makes it text, which keeps it.
      { name: 'count', label: 'count', type: 'string' },
      { name: 'open', label: 'open', type: 'boolean' },
      { name: 'note', label: 'note', type: 'string' },
      { name: 'extra', label: 'extra', type: 'number' },
    ]);
  });

  it('returns no columns for rows without properties', async () => {
    expect(
      await deriveExportFields(batches([{ properties: null }, {}])),
    ).toEqual([]);
  });
});
