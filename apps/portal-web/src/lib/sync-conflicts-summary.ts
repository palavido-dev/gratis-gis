// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SyncConflictArtifact } from '@gratis-gis/shared-types';

export type SyncConflictCopy = {
  losingDelete: string;
  losingEmpty: string;
  losingSummary: (sample: string) => string;
  losingMore: (count: number) => string;
};

/** Pure summary of a conflict's losing side for the review panel. */
export function summarizeSyncConflictLosingSide(
  c: SyncConflictArtifact,
  copy: SyncConflictCopy,
): string {
  if (c.op === 'delete' || !c.losingSide) {
    return copy.losingDelete;
  }
  const props = c.losingSide.properties ?? {};
  const keys = Object.keys(props).filter(
    (k) => !k.startsWith('_') && props[k] !== undefined && props[k] !== null,
  );
  if (keys.length === 0) {
    return copy.losingEmpty;
  }
  const sample = keys.slice(0, 4).map((k) => {
    const v = props[k];
    const shown =
      typeof v === 'string'
        ? v.length > 40
          ? `${v.slice(0, 37)}...`
          : v
        : String(v);
    return `${k}=${shown}`;
  });
  const more =
    keys.length > 4 ? copy.losingMore(keys.length - 4) : '';
  return copy.losingSummary(sample.join(', ') + more);
}
