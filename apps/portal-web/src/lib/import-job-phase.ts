// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which step a running import is in, for the import banner.
 *
 * Once the worker has read every feature it still has to seal the
 * load, stamp every row and commit, plus recompute the extent. On a
 * large layer that takes minutes (468,000 polygons in #573), and the
 * banner used to sit at 100% with nothing to say it was still working.
 * processedFeatures reaching totalFeatures marks that step.
 */

export type ImportJobPhase = 'queued' | 'starting' | 'loading' | 'finishing' | 'done';

export interface ImportJobProgress {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  totalFeatures: number | null;
  processedFeatures: number;
  insertedFeatures: number;
}

export function importJobPhase(job: ImportJobProgress): ImportJobPhase {
  if (job.status === 'queued') return 'queued';
  if (job.status !== 'running') return 'done';
  const total = job.totalFeatures ?? 0;
  if (total > 0 && job.processedFeatures >= total) return 'finishing';
  if (job.processedFeatures > 0 || job.insertedFeatures > 0) return 'loading';
  return 'starting';
}
