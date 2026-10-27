// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SyncConflictArtifact } from '@gratis-gis/shared-types';
import {
  planSyncConflictReapply,
  stripSyncConflictUserProperties,
} from './sync-conflicts-reapply';

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

describe('stripSyncConflictUserProperties', () => {
  it('drops underscore keys and keeps user attrs', () => {
    expect(
      stripSyncConflictUserProperties({
        name: 'Oak',
        _global_id: 'g',
        _observation_id: 'o',
        count: 3,
      }),
    ).toEqual({ name: 'Oak', count: 3 });
  });

  it('returns empty for nullish', () => {
    expect(stripSyncConflictUserProperties(null)).toEqual({});
    expect(stripSyncConflictUserProperties(undefined)).toEqual({});
  });
});

describe('planSyncConflictReapply', () => {
  const losingFeature = {
    type: 'Feature' as const,
    id: 'f1',
    geometry: { type: 'Point' as const, coordinates: [1, 2] },
    properties: {
      name: 'Oak',
      _global_id: 'f1',
      _observation_id: 'old-obs',
    },
  };

  it('PATCHes an update when the feature is still live', () => {
    const plan = planSyncConflictReapply(
      artifact({
        id: 'c1',
        featureId: 'f1',
        op: 'update',
        losingSide: losingFeature,
      }),
      { exists: true, observationId: 'live-obs' },
    );
    expect(plan).toEqual({
      method: 'PATCH',
      featureId: 'f1',
      body: {
        geometry: losingFeature.geometry,
        properties: { name: 'Oak' },
        baseObservationId: 'live-obs',
      },
    });
  });

  it('POSTs a recreate when an update target is gone', () => {
    const plan = planSyncConflictReapply(
      artifact({
        id: 'c1',
        featureId: 'f1',
        op: 'update',
        losingSide: losingFeature,
      }),
      { exists: false },
    );
    expect(plan).toEqual({
      method: 'POST',
      body: {
        features: [
          {
            globalId: 'f1',
            geometry: losingFeature.geometry,
            properties: { name: 'Oak' },
          },
        ],
      },
    });
  });

  it('DELETEs when a lost delete still has a live feature', () => {
    const plan = planSyncConflictReapply(
      artifact({ id: 'c1', featureId: 'f1', op: 'delete' }),
      { exists: true, observationId: 'live-obs' },
    );
    expect(plan).toEqual({
      method: 'DELETE',
      featureId: 'f1',
      body: { baseObservationId: 'live-obs' },
    });
  });

  it('noops when a lost delete is already gone', () => {
    expect(
      planSyncConflictReapply(
        artifact({ id: 'c1', featureId: 'f1', op: 'delete' }),
        { exists: false },
      ),
    ).toEqual({ method: 'noop', reason: 'already-deleted' });
  });

  it('refuses updates without a losing side', () => {
    expect(
      planSyncConflictReapply(
        artifact({ id: 'c1', featureId: 'f1', op: 'update' }),
        { exists: true, observationId: 'o' },
      ),
    ).toEqual({ method: 'unavailable', reason: 'missing-losing-side' });
  });
});
