// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SyncConflictArtifact } from '@gratis-gis/shared-types';

/**
 * Drop `_`-prefixed system keys before a re-apply write. The read path
 * inlines `_global_id`, `_observation_id`, `_edited_*`, etc.; writing
 * them back would freeze stale editor-tracking into attrs.
 */
export function stripSyncConflictUserProperties(
  props: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

/** Live head probe used to pick PATCH / DELETE vs POST recreate. */
export type SyncConflictLiveHead = {
  exists: boolean;
  /** Current `_observation_id` when the feature is still live. */
  observationId?: string;
};

export type SyncConflictReapplyPlan =
  | {
      method: 'PATCH';
      featureId: string;
      body: {
        geometry?: unknown;
        properties: Record<string, unknown>;
        baseObservationId?: string;
      };
    }
  | {
      method: 'DELETE';
      featureId: string;
      body: {
        baseObservationId?: string;
      };
    }
  | {
      method: 'POST';
      body: {
        features: Array<{
          globalId: string;
          geometry?: unknown;
          properties: Record<string, unknown>;
        }>;
      };
    }
  | {
      /** Delete already applied (feature gone); nothing to write. */
      method: 'noop';
      reason: 'already-deleted';
    }
  | {
      method: 'unavailable';
      reason: 'missing-losing-side';
    };

/**
 * Choose the write that re-applies a losing-side syncConflicts artifact.
 *
 * - update + live feature → PATCH with stripped losing attrs/geometry
 *   and the live `baseObservationId`
 * - update + feature gone → POST recreate (same globalId when possible)
 * - delete + live feature → DELETE with live `baseObservationId`
 * - delete + feature gone → noop (already matches the losing intent)
 */
export function planSyncConflictReapply(
  conflict: SyncConflictArtifact,
  live: SyncConflictLiveHead,
): SyncConflictReapplyPlan {
  if (conflict.op === 'delete') {
    if (!live.exists) {
      return { method: 'noop', reason: 'already-deleted' };
    }
    return {
      method: 'DELETE',
      featureId: conflict.featureId,
      body: {
        ...(live.observationId !== undefined
          ? { baseObservationId: live.observationId }
          : {}),
      },
    };
  }

  if (!conflict.losingSide) {
    return { method: 'unavailable', reason: 'missing-losing-side' };
  }

  const properties = stripSyncConflictUserProperties(
    conflict.losingSide.properties,
  );
  const geometry =
    conflict.losingSide.geometry !== undefined &&
    conflict.losingSide.geometry !== null
      ? conflict.losingSide.geometry
      : undefined;

  if (!live.exists) {
    return {
      method: 'POST',
      body: {
        features: [
          {
            globalId: conflict.featureId,
            ...(geometry !== undefined ? { geometry } : {}),
            properties,
          },
        ],
      },
    };
  }

  return {
    method: 'PATCH',
    featureId: conflict.featureId,
    body: {
      ...(geometry !== undefined ? { geometry } : {}),
      properties,
      ...(live.observationId !== undefined
        ? { baseObservationId: live.observationId }
        : {}),
    },
  };
}
