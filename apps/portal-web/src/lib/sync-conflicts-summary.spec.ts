// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SyncConflictArtifact } from '@gratis-gis/shared-types';
import { summarizeSyncConflictLosingSide } from './sync-conflicts-summary';

const copy = {
  losingDelete: 'delete',
  losingEmpty: 'empty',
  losingSummary: (sample: string) => `attrs: ${sample}`,
  losingMore: (count: number) => ` (+${count})`,
};

function artifact(
  partial: Partial<SyncConflictArtifact> &
    Pick<SyncConflictArtifact, 'id' | 'featureId' | 'op'>,
): SyncConflictArtifact {
  return {
    at: '2026-10-27T12:00:00.000Z' as SyncConflictArtifact['at'],
    losingSide: null,
    current: null,
    ...partial,
  };
}

describe('summarizeSyncConflictLosingSide', () => {
  it('describes deletes', () => {
    expect(
      summarizeSyncConflictLosingSide(
        artifact({ id: '1', featureId: 'f', op: 'delete' }),
        copy,
      ),
    ).toBe('delete');
  });

  it('summarizes attribute samples and elides the rest', () => {
    const out = summarizeSyncConflictLosingSide(
      artifact({
        id: '1',
        featureId: 'f',
        op: 'update',
        losingSide: {
          type: 'Feature',
          id: 'f',
          geometry: null,
          properties: {
            a: 1,
            b: 2,
            c: 3,
            d: 4,
            e: 5,
            _internal: 'x',
          },
        },
      }),
      copy,
    );
    expect(out).toBe('attrs: a=1, b=2, c=3, d=4 (+1)');
  });

  it('reports empty properties', () => {
    expect(
      summarizeSyncConflictLosingSide(
        artifact({
          id: '1',
          featureId: 'f',
          op: 'update',
          losingSide: {
            type: 'Feature',
            id: 'f',
            geometry: null,
            properties: {},
          },
        }),
        copy,
      ),
    ).toBe('empty');
  });
});
