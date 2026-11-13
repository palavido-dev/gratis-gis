// SPDX-License-Identifier: AGPL-3.0-or-later
import { FormsService, repeatGroupTargetSublayer } from './forms.service.js';

/**
 * A form made with "Start from a data layer" is linked to someone's
 * existing layer, where the designer creates no new sublayers. Its
 * repeat groups carry `bindTo.layerKey` naming the related table they
 * came from, and their rows now go there, linked to the parent row
 * through the table's own parentFkColumn. Before, the mirror looked
 * only for a sublayer named after the group id and skipped them.
 */
describe('repeatGroupTargetSublayer', () => {
  const keys = new Set(['facilities', 'inspections', 'visits']);

  it('uses the related table the group is bound to', () => {
    expect(
      repeatGroupTargetSublayer({ id: 'insp', bindTo: { layerKey: 'inspections' } }, keys, 'facilities'),
    ).toBe('inspections');
  });

  it('falls back to the sublayer named after the group (the paired layer case)', () => {
    expect(repeatGroupTargetSublayer({ id: 'visits' }, keys, 'facilities')).toBe('visits');
  });

  it('never targets the parent sublayer or a missing one', () => {
    expect(
      repeatGroupTargetSublayer({ id: 'x', bindTo: { layerKey: 'facilities' } }, keys, 'facilities'),
    ).toBeNull();
    expect(
      repeatGroupTargetSublayer({ id: 'x', bindTo: { layerKey: 'gone' } }, keys, 'facilities'),
    ).toBeNull();
  });
});

describe('repeat group mirror on an existing layer', () => {
  it('writes instances into the bound table with its parent key set', async () => {
    const insertFeatures = jest.fn(async () => undefined);
    const prisma = {
      item: {
        findUnique: jest.fn(async () => ({
          data: {
            layers: [
              { id: 'facilities', geometryType: 'point' },
              {
                id: 'inspections',
                geometryType: null,
                parentLayerId: 'facilities',
                parentFkColumn: 'facility_gid',
              },
            ],
          },
        })),
      },
    };
    const svc = new FormsService(
      prisma as never,
      {} as never,
      { insertFeatures } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await (
      svc as unknown as {
        mirrorRepeatGroupsToChildSublayers: (a: unknown) => Promise<void>;
      }
    ).mirrorRepeatGroupsToChildSublayers({
      formData: {
        questions: [
          {
            id: 'inspections_1',
            type: 'group',
            repeat: {},
            bindTo: { layerKey: 'inspections' },
            children: [{ id: 'notes', type: 'text', label: 'Notes' }],
          },
        ],
      },
      layerId: 'layer-1',
      parentLayerKey: 'facilities',
      response: { inspections_1: [{ notes: 'ok' }, { notes: 'leak' }] },
      parentGlobalId: 'sub-1',
      clientId: 'c-1',
      schemaVersion: 1,
      capturedAt: new Date(0),
      submittedBy: 'u-1',
      user: { id: 'u-1' },
    });
    expect(insertFeatures).toHaveBeenCalledTimes(1);
    const [layerId, sublayer, rows, , opts] = insertFeatures.mock.calls[0] as unknown as [
      string,
      string,
      Array<{ properties: Record<string, unknown> }>,
      unknown,
      { isTable: boolean },
    ];
    expect(layerId).toBe('layer-1');
    expect(sublayer).toBe('inspections');
    expect(opts.isTable).toBe(true);
    expect(rows.map((r) => r.properties.notes)).toEqual(['ok', 'leak']);
    expect(rows.every((r) => r.properties.facility_gid === 'sub-1')).toBe(true);
  });
});
