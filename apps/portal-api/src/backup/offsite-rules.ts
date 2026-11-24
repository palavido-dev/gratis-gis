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
  /** When the bucket says the first of its files was written, if known. */
  lastModified?: Date | null;
}

/**
 * How far a name's time stamp may be ahead of the clock (or of the time
 * the bucket says the file was written) before the copy is set aside.
 * Covers clock differences between this server and the provider.
 */
export const FUTURE_MARGIN_MS = 60 * 60 * 1000;

/**
 * Why a copy's name cannot be trusted for its age, or null. A name
 * dated after now (plus the margin) would count as the newest copy for
 * ever; a name dated well after the time the provider recorded for the
 * upload was not written by this portal's clock. Such a copy is never
 * picked as newest and never deleted by retention: it is reported.
 */
export function suspectDate(a: OffsiteArtifact, now: Date): 'future' | 'after-upload' | null {
  const t = a.createdAt.getTime();
  if (t > now.getTime() + FUTURE_MARGIN_MS) return 'future';
  if (a.lastModified && t > a.lastModified.getTime() + FUTURE_MARGIN_MS) return 'after-upload';
  return null;
}

/** Split artifacts into those with a usable date and those set aside. */
export function partitionByDate<T extends OffsiteArtifact>(
  artifacts: readonly T[],
  now: Date,
): { usable: T[]; suspect: T[] } {
  const usable: T[] = [];
  const suspect: T[] = [];
  for (const a of artifacts) (suspectDate(a, now) ? suspect : usable).push(a);
  return { usable, suspect };
}

/** The newest complete artifact with a usable date, or null. */
export function newestGood<T extends OffsiteArtifact>(
  artifacts: readonly T[],
  now: Date,
): T | null {
  let best: T | null = null;
  for (const a of partitionByDate(artifacts, now).usable) {
    if (!a.complete) continue;
    if (!best || a.createdAt.getTime() > best.createdAt.getTime()) best = a;
  }
  return best;
}

/**
 * Artifacts retention may delete: every one created before the
 * cutoff, except the newest complete one, which is kept whatever its
 * age. Incomplete artifacts younger than the cutoff are kept too,
 * since one of them may be an upload still running. Artifacts whose
 * date is suspect (see suspectDate) are neither deleted nor counted
 * as the newest: the caller reports them.
 */
export function selectExpired(
  artifacts: readonly OffsiteArtifact[],
  now: Date,
  retentionDays: number,
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) return [];
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const { usable } = partitionByDate(artifacts, now);
  const newestComplete = newestGood(usable, now);
  return usable
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
  /** Names the portal that owns the folder. Plain JSON, no secrets. */
  installMarker: 'gratisgis-install.json',
} as const;

const STAMP_RE = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?/;

/** A local archive name exactly as the portal writes it. No "/". */
export const ARCHIVE_NAME_RE =
  /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}\.tar\.gz$/;

/** A mirror run folder name: the archive's time stamp and run id. No "/". */
export const MIRROR_RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/;

/** An encrypted archive or its sidecar, directly under archives/. */
const SEALED_ARCHIVE_RE =
  /^(backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}\.tar\.gz\.enc)(\.json)?$/;

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
 * upload verified. Only names the portal writes count: anything else,
 * including names in sub-folders, is ignored.
 */
export function archiveArtifacts(
  listing: Iterable<{ key: string; lastModified: Date | null; size?: number }>,
  archivesPrefix: string,
): Array<OffsiteArtifact & { keys: string[]; sealedBytes: number | null }> {
  const byId = new Map<string, OffsiteArtifact & { keys: string[]; sealedBytes: number | null }>();
  for (const o of listing) {
    if (!o.key.startsWith(archivesPrefix)) continue;
    const m = SEALED_ARCHIVE_RE.exec(o.key.slice(archivesPrefix.length));
    if (!m) continue;
    const id = m[1]!;
    const sidecar = m[2] !== undefined;
    const at = stampFromName(id) ?? o.lastModified ?? new Date(0);
    const cur = byId.get(id) ?? {
      id,
      createdAt: at,
      complete: false,
      keys: [],
      lastModified: null,
      sealedBytes: null,
    };
    cur.keys.push(o.key);
    if (sidecar) cur.complete = true;
    else if (o.size !== undefined) cur.sealedBytes = o.size;
    if (o.lastModified && (!cur.lastModified || o.lastModified < cur.lastModified)) {
      cur.lastModified = o.lastModified;
    }
    byId.set(id, cur);
  }
  // A sidecar without its archive is not a usable copy.
  for (const a of byId.values()) {
    if (a.complete && !a.keys.some((k) => k.endsWith(OFFSITE_LAYOUT.sealed))) a.complete = false;
  }
  return [...byId.values()];
}
