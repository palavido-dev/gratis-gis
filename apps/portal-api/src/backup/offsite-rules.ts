// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure decisions for off-site copies: which ones retention removes,
 * when to raise a "no off-site copy lately" notice, and how artifacts
 * are named in the bucket. No I/O here, so every rule has a unit test.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention reads at most this many sidecars with a bad signature per
 * pass; older complete copies are then left for a later pass.
 */
export const MAX_SET_ASIDE_CHECKED = 100;

export interface OffsiteArtifact {
  /** Stable id: the encrypted archive's name in the bucket. */
  id: string;
  createdAt: Date;
  /** The completion marker exists: the upload finished and verified. */
  complete: boolean;
  /** When the bucket says the first of its files was written, if known. */
  lastModified?: Date | null;
  /**
   * What its signature says (see offsite-sign.ts):
   * - verified: signed by a trusted key and matching the copy.
   * - legacy: not signed, made by this portal before signing existed.
   * - unsigned: not signed, and not known to be this portal's.
   * - bad: anything else (a signature that does not verify or does not
   *   match, an unknown signer, another portal's install id).
   * Unset means it was not checked, and counts as legacy.
   */
  trust?: ArtifactTrust;
}

export type ArtifactTrust = 'verified' | 'legacy' | 'unsigned' | 'bad';

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

/**
 * Why a copy is set aside (kept, never counted as the newest, never
 * deleted by retention, reported), or null: a suspect date, or a
 * signature that is bad.
 */
export function setAsideReason(
  a: OffsiteArtifact,
  now: Date,
): 'future' | 'after-upload' | 'bad-signature' | null {
  return suspectDate(a, now) ?? (a.trust === 'bad' ? 'bad-signature' : null);
}

/** Split artifacts into those usable and those set aside. */
export function partitionByDate<T extends OffsiteArtifact>(
  artifacts: readonly T[],
  now: Date,
): { usable: T[]; suspect: T[] } {
  const usable: T[] = [];
  const suspect: T[] = [];
  for (const a of artifacts) (setAsideReason(a, now) ? suspect : usable).push(a);
  return { usable, suspect };
}

/**
 * The newest good copy, or null: the newest complete verified copy
 * with a usable date. Only when there is none, the newest complete
 * legacy copy (made by this portal before signing existed). Unsigned
 * copies not known to be this portal's, and set-aside ones, never are.
 */
export function newestGood<T extends OffsiteArtifact>(
  artifacts: readonly T[],
  now: Date,
): T | null {
  let verified: T | null = null;
  let legacy: T | null = null;
  for (const a of partitionByDate(artifacts, now).usable) {
    if (!a.complete) continue;
    const t = a.trust ?? 'legacy';
    if (t === 'verified') {
      if (!verified || a.createdAt.getTime() > verified.createdAt.getTime()) verified = a;
    } else if (t === 'legacy') {
      if (!legacy || a.createdAt.getTime() > legacy.createdAt.getTime()) legacy = a;
    }
  }
  return verified ?? legacy;
}

/**
 * Artifacts retention may delete: every one created before the
 * cutoff, except the newest complete one, which is kept whatever its
 * age. Incomplete artifacts younger than the cutoff are kept too,
 * since one of them may be an upload still running. Artifacts set
 * aside (a suspect date or a bad signature, see setAsideReason) are
 * neither deleted nor counted as the newest: the caller reports them.
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
  /** Suffix of every encrypted file. */
  sealed: '.enc',
  /** Written after an archive upload verified. Plain JSON, no secrets. */
  sidecar: '.enc.json',
  /** Names the portal that owns the folder. Plain JSON, no secrets. */
  installMarker: 'gratisgis-install.json',
} as const;

const STAMP_RE = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?/;

/**
 * The name of an off-site copy, without ".enc": the local archive name,
 * or for a copy uploaded again under a new name, that name with
 * "-r<attempt>" (2 to 999) before ".tar.gz". No "/".
 */
export const COPY_NAME_RE =
  /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}(?:-r(?:[2-9]|[1-9]\d{1,2}))?\.tar\.gz$/;

/** An encrypted archive or its sidecar, directly under archives/. */
const SEALED_ARCHIVE_RE =
  /^(backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}(?:-r(?:[2-9]|[1-9]\d{1,2}))?\.tar\.gz\.enc)(\.json)?$/;

/** The highest attempt number a copy name may carry. */
export const MAX_COPY_ATTEMPT = 999;

/**
 * The bucket name (with ".enc") for one upload attempt of a local
 * archive: attempt 1 is the archive's own name, later ones add
 * "-r<attempt>".
 */
export function copyObjectName(archive: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_COPY_ATTEMPT) {
    throw new Error('Unexpected upload attempt number.');
  }
  const base = archive.slice(0, -'.tar.gz'.length);
  return `${attempt === 1 ? archive : `${base}-r${attempt}.tar.gz`}${OFFSITE_LAYOUT.sealed}`;
}

/** The attempt number in a copy's bucket name (1 when it has none). */
export function copyAttempt(id: string): number {
  const m = /-r([2-9]|[1-9]\d{1,2})\.tar\.gz\.enc$/.exec(id);
  return m ? Number(m[1]) : 1;
}

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
 * Group a listing of archives/ into artifacts. An archive is complete
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
