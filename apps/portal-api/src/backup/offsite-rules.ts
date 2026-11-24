// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure decisions for off-site copies: which ones retention removes,
 * when to raise a "no off-site copy lately" notice, and how artifacts
 * are named in the bucket. No I/O here, so every rule has a unit test.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OffsiteArtifact {
  /** Stable id: the archive name, or the mirror run folder. */
  id: string;
  createdAt: Date;
  /** The completion marker exists: the upload finished and verified. */
  complete: boolean;
}

/**
 * Artifacts retention may delete: every one created before the
 * cutoff, except the newest complete one, which is kept whatever its
 * age. Incomplete artifacts younger than the cutoff are kept too,
 * since one of them may be an upload still running.
 */
export function selectExpired(
  artifacts: readonly OffsiteArtifact[],
  now: Date,
  retentionDays: number,
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) return [];
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  let newestComplete: OffsiteArtifact | null = null;
  for (const a of artifacts) {
    if (!a.complete) continue;
    if (!newestComplete || a.createdAt.getTime() > newestComplete.createdAt.getTime()) {
      newestComplete = a;
    }
  }
  return artifacts
    .filter((a) => a !== newestComplete && a.createdAt.getTime() < cutoff)
    .map((a) => a.id);
}

/**
 * Mirror objects no retained run refers to. Objects newer than the
 * grace period are kept: a run uploads its objects before it writes
 * the index that refers to them.
 */
export function unreferencedObjects(
  objects: Iterable<{ key: string; lastModified: Date | null }>,
  referenced: ReadonlySet<string>,
  now: Date,
  graceDays = 2,
): string[] {
  const cutoff = now.getTime() - graceDays * DAY_MS;
  const out: string[] = [];
  for (const o of objects) {
    if (referenced.has(o.key)) continue;
    if (!o.lastModified || o.lastModified.getTime() >= cutoff) continue;
    out.push(o.key);
  }
  return out;
}

/**
 * The notice key for "no good off-site copy in `alertDays`", or null
 * when no notice is due. One key per quiet period: the key names the
 * last good run, so a later success starts a new period and the same
 * period never notifies twice.
 *
 * With no success ever, the clock starts at the first attempt, so
 * turning the feature on does not alert at once.
 */
export function staleNoticeKey(args: {
  enabled: boolean;
  alertDays: number;
  now: Date;
  lastSuccess: { runId: string; at: Date } | null;
  firstAttemptAt: Date | null;
}): string | null {
  if (!args.enabled) return null;
  const limit = args.alertDays * DAY_MS;
  if (args.lastSuccess) {
    return args.now.getTime() - args.lastSuccess.at.getTime() > limit
      ? `stale:${args.lastSuccess.runId}`
      : null;
  }
  if (args.firstAttemptAt && args.now.getTime() - args.firstAttemptAt.getTime() > limit) {
    return 'stale:none';
  }
  return null;
}

/** Whole days since `from`, for the notice text. */
export function daysSince(from: Date | null, now: Date): number | null {
  if (!from) return null;
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

/** Bucket layout under the configured prefix. */
export const OFFSITE_LAYOUT = {
  archives: 'archives/',
  mirrorRuns: 'mirror/runs/',
  mirrorObjects: 'mirror/objects/',
  /** Suffix of every encrypted file. */
  sealed: '.enc',
  /** Written after an archive upload verified. Plain JSON, no secrets. */
  sidecar: '.enc.json',
  /** Written last in a mirror run folder. */
  doneMarker: 'done.json',
} as const;

const STAMP_RE = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?/;

/**
 * The time in a backup file or folder name such as
 * backup-2026-11-24T02-00-00-123-abcdef12.tar.gz. Null when the name
 * has none, in which case the caller falls back to the object's own
 * date.
 */
export function stampFromName(name: string): Date | null {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Group an archive-mode listing into artifacts. An archive is complete
 * when its sidecar exists; the sidecar is written only after the
 * upload verified.
 */
export function archiveArtifacts(
  listing: Iterable<{ key: string; lastModified: Date | null }>,
  archivesPrefix: string,
): Array<OffsiteArtifact & { keys: string[] }> {
  const byId = new Map<string, OffsiteArtifact & { keys: string[] }>();
  for (const o of listing) {
    if (!o.key.startsWith(archivesPrefix)) continue;
    const name = o.key.slice(archivesPrefix.length);
    let id: string;
    let sidecar = false;
    if (name.endsWith(OFFSITE_LAYOUT.sidecar)) {
      id = name.slice(0, -'.json'.length);
      sidecar = true;
    } else if (name.endsWith(OFFSITE_LAYOUT.sealed)) {
      id = name;
    } else {
      continue;
    }
    const at = stampFromName(id) ?? o.lastModified ?? new Date(0);
    const cur = byId.get(id) ?? { id, createdAt: at, complete: false, keys: [] };
    cur.keys.push(o.key);
    if (sidecar) cur.complete = true;
    byId.set(id, cur);
  }
  // A sidecar without its archive is not a usable copy.
  for (const a of byId.values()) {
    if (a.complete && !a.keys.some((k) => k.endsWith(OFFSITE_LAYOUT.sealed))) a.complete = false;
  }
  return [...byId.values()];
}
