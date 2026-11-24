// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Command line helper for restoring from off-site copies on a server
 * that has no working portal yet. infra/restore-from-offsite.sh runs it
 * inside the portal-api image:
 *
 *   node dist/backup/offsite-cli.js list
 *   node dist/backup/offsite-cli.js describe KEY [--name ARCHIVE | --run RUN] [ALLOW]
 *   node dist/backup/offsite-cli.js check-key KEY
 *   node dist/backup/offsite-cli.js fetch KEY --out DIR --confirm-copy NAME [--name ARCHIVE] [ALLOW]
 *   node dist/backup/offsite-cli.js fetch-mirror KEY --out DIR --confirm-copy NAME [--run RUN] [ALLOW]
 *   node dist/backup/offsite-cli.js put-objects --archive FILE
 *   node dist/backup/offsite-cli.js put-mirror-objects KEY --run RUN [--work DIR] [ALLOW]
 *   node dist/backup/offsite-cli.js count-objects
 *
 * where KEY is either `--key-file F --passphrase-stdin` (the passphrase
 * alone on standard input) or `--key-stdin` (standard input holds the
 * key file in base64 on its first line, then the passphrase; this is
 * how restore-from-offsite.sh sends both into the container without a
 * file the container's user would need to read).
 *
 * Bucket settings come from the BACKUP_OFFSITE_* variables; the local
 * object store from MINIO_*. The key file is the admin's sealed key
 * file (infra/recovery/offsite-key.mjs). Its passphrase is never an
 * argument; one trailing line break is dropped and Unicode NFC applied.
 * Results are printed as key=value lines on stdout for the script;
 * progress goes to stderr.
 *
 * Signatures: every copy carries a signature by the portal's signing
 * key (offsite-sign.ts). The key file holds the verify keys the admin
 * added to it. Every command that uses a copy checks its signature
 * against those keys first, before anything is downloaded, decrypted
 * or changed. A copy is in one of these states:
 *
 *   verified   signed with a verify key in the key file, for this
 *              folder's portal install. Used without a flag.
 *   foreign    signed with a verify key in the key file, but for
 *              another portal install. Used with --allow-foreign-install.
 *   untrusted  names a verify key the key file does not hold, so the
 *              signature is not checked. Used with --allow-untrusted-signer.
 *   unsigned   no signature (made before signing existed). Used with
 *              --allow-unsigned-copy.
 *   bad        a signature that does not verify, or is for another
 *              copy. Never used.
 *
 * ALLOW above is any of those three flags; each one admits only its
 * own state. Without the flag a command exits with status 3 and prints
 * needs=<state>. For a verified or foreign copy, the size and SHA-256
 * of each downloaded object are checked against the signed record
 * before it is decrypted; nothing unsigned is used for that. For an
 * untrusted or unsigned copy only the unsigned records in the bucket
 * are there to check against, which catches damage but not a
 * deliberate change.
 *
 * `describe` names the copy a restore would use (the one named, or the
 * newest verified one) with its date, size, key fingerprint, its state
 * and what was and was not checked, and changes nothing. With no
 * verified copy, the newest foreign copy is offered first, then the
 * newest untrusted one, then the newest unsigned one. `fetch` and
 * `fetch-mirror` download only when --confirm-copy repeats that
 * copy's name. A copy dated in the future is never picked as the
 * newest; it is used only when named. `fetch-mirror` also checks,
 * before it finishes, that every file the run's index lists is in the
 * bucket with the recorded size.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  isValidOffsitePrefix,
  normalizePrefix,
  OFFSITE_ENV,
  resolveOffsiteSettings,
  type OffsiteRow,
  type OffsiteSettings,
} from './offsite-config.js';
import { openKeyFile, type OffsiteKeyFile } from './offsite-crypto.js';
import { endpointPolicy } from './offsite-endpoint.js';
import {
  ARCHIVE_NAME_RE,
  archiveArtifacts,
  MIRROR_RUN_RE,
  newestGood,
  OFFSITE_LAYOUT,
  suspectDate,
  type OffsiteArtifact,
} from './offsite-rules.js';
import {
  checkSignature,
  type ArchiveManifest,
  type CopyCheck,
  type CopyTrust,
  type MirrorManifest,
  type SignedManifest,
} from './offsite-sign.js';
import {
  createOffsiteClient,
  describeS3Error,
  getSmall,
  listLevel,
  listObjects,
  type S3Like,
} from './offsite-store.js';
import { extractTarGz, readTarEntry } from './tar-cli.js';
import { fetchChecked, OffsiteMirror } from './offsite-mirror.js';

/** Same name as backup.service.ts; not imported, to keep Nest out of the CLI. */
const MINIO_META_MEMBER = 'minio-meta.json';
const SAFE_VALUE = /^[A-Za-z0-9._:/@+-]{0,300}$/;
const FINGERPRINT_RE = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;
/** How deep, and through how many folders, the restore looks for a portal folder. */
const FIND_DEPTH = 4;
const FIND_FOLDERS = 200;
/** A copy that is not verified but may be used with its own flag. */
export type AllowedState = 'foreign' | 'untrusted' | 'unsigned';
/** The flag that admits each state, and only that state. */
export const ALLOW_FLAGS: Readonly<Record<AllowedState, string>> = {
  foreign: '--allow-foreign-install',
  untrusted: '--allow-untrusted-signer',
  unsigned: '--allow-unsigned-copy',
};
/** Exit status when a copy is not verified and its flag was not given. */
export const EXIT_UNVERIFIED = 3;

/** The copy is not verified, and the flag for its state was not given. */
class UnverifiedCopyError extends Error {
  constructor(
    message: string,
    readonly state: AllowedState,
  ) {
    super(message);
  }
}

const EMPTY_ROW: OffsiteRow = {
  offsiteEnabled: null,
  offsiteEndpoint: null,
  offsiteRegion: null,
  offsiteBucket: null,
  offsitePrefix: null,
  offsitePathStyle: null,
  offsiteAccessKeyId: null,
  offsitePublicKey: null,
  offsiteInstallId: null,
  offsiteRetentionDays: null,
  offsiteAlertDays: null,
  offsiteMirrorThresholdBytes: null,
};

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: () => Promise<string>;
  env: (name: string) => string | undefined;
  readFile: (p: string) => Promise<Buffer>;
  offsite: (s: OffsiteSettings) => S3Like;
  local: () => { s3: S3Like; bucket: string };
}

/** Print a result line, refusing anything that could break the shell. */
function result(io: CliIo, key: string, value: string | number) {
  const v = String(value);
  if (!SAFE_VALUE.test(v)) throw new Error(`Refusing to print an unexpected ${key}.`);
  io.out(`${key}=${v}`);
}

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value.`);
  return v;
}

/**
 * Folders under `base` that hold a portal marker, looking down at most
 * FIND_DEPTH levels and FIND_FOLDERS folders. A folder with a marker
 * is not searched further. Also returns every folder looked at, so a
 * failure can say what was there.
 */
export async function findPortalFolders(
  s3: S3Like,
  bucket: string,
  base: string,
): Promise<{ found: string[]; seen: string[] }> {
  const found: string[] = [];
  const seen: string[] = [];
  const queue: Array<{ prefix: string; depth: number }> = [{ prefix: base, depth: 0 }];
  while (queue.length > 0 && seen.length < FIND_FOLDERS) {
    const { prefix, depth } = queue.shift()!;
    seen.push(prefix);
    const level = await listLevel(s3, bucket, prefix);
    if (level.keys.includes(`${prefix}${OFFSITE_LAYOUT.installMarker}`)) {
      found.push(prefix);
      continue;
    }
    if (depth >= FIND_DEPTH) continue;
    for (const p of level.prefixes) queue.push({ prefix: p, depth: depth + 1 });
  }
  return { found, seen };
}

function describeSeen(seen: string[]): string {
  const shown = seen.slice(0, 20).map((p) => (p === '' ? '(top of the bucket)' : p));
  return `${shown.join(', ')}${seen.length > shown.length ? ` and ${seen.length - shown.length} more` : ''}`;
}

/**
 * Bucket settings from the environment, and the portal folder: the one
 * BACKUP_OFFSITE_PREFIX names, or the only portal folder found under it
 * (or in the whole bucket when it is unset). Never falls back to a
 * default folder: when none or several are found, it stops and lists
 * what it saw.
 */
async function settingsFrom(io: CliIo): Promise<OffsiteSettings> {
  const s = resolveOffsiteSettings(
    EMPTY_ROW,
    { secretFromDb: null },
    io.env,
    endpointPolicy(io.env),
  );
  const missing = [
    !s.endpoint && OFFSITE_ENV.endpoint,
    !s.bucket && OFFSITE_ENV.bucket,
    !s.accessKeyId && OFFSITE_ENV.accessKeyId,
    !s.secretAccessKey && OFFSITE_ENV.secretAccessKey,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error([`Set these in the env file: ${missing.join(', ')}.`, ...s.problems].join(' '));
  }
  const raw = io.env(OFFSITE_ENV.prefix)?.trim() ?? '';
  const given = raw ? normalizePrefix(raw) : null;
  if (raw && given === '') {
    throw new Error(
      `${OFFSITE_ENV.prefix} cannot be empty or "/". Set it to the portal's folder, or leave it unset to search the bucket.`,
    );
  }
  const prefixProblem = s.problems.find((p) => /folder prefix/i.test(p));
  if (prefixProblem) throw new Error(prefixProblem);
  const s3 = io.offsite(s);
  const { found, seen } = await findPortalFolders(s3, s.bucket!, given ?? '');
  if (found.length === 1) {
    // Same folder rule as the page and the restore script.
    if (!isValidOffsitePrefix(found[0]!)) {
      throw new Error(
        `The portal folder ${JSON.stringify(found[0])} has characters the restore does not accept. Copy it to a folder named with letters, digits, ".", "_" and "-", then set ${OFFSITE_ENV.prefix}.`,
      );
    }
    s.prefix = found[0]!;
    if (s.prefix !== given) {
      io.err(`Using the folder ${s.prefix} (set ${OFFSITE_ENV.prefix} to choose another).`);
    }
    return s;
  }
  if (found.length > 1) {
    throw new Error(
      `Found several portal folders (${found.join(', ')}). Set ${OFFSITE_ENV.prefix} to the one to restore.`,
    );
  }
  throw new Error(
    `No portal folder (a folder holding ${OFFSITE_LAYOUT.installMarker}) was found ${given ? `in or under ${given}` : 'in the bucket'}. Looked in: ${describeSeen(seen)}. Set ${OFFSITE_ENV.prefix} to the folder that holds the copies.`,
  );
}

/**
 * The admin's private key: the sealed key file and its passphrase, as
 * --key-file plus --passphrase-stdin, or both on standard input with
 * --key-stdin.
 */
async function privateKeyFrom(io: CliIo, args: string[]): Promise<OffsiteKeyFile> {
  let bytes: Buffer;
  let pass: string;
  if (args.includes('--key-stdin')) {
    const input = await io.stdin();
    const nl = input.indexOf('\n');
    const first = (nl < 0 ? input : input.slice(0, nl)).trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(first)) {
      throw new Error('Standard input must start with the key file in base64 on one line.');
    }
    bytes = Buffer.from(first, 'base64');
    pass = nl < 0 ? '' : input.slice(nl + 1);
  } else {
    const file = arg(args, '--key-file');
    if (!file) throw new Error('--key-file (or --key-stdin) is required.');
    if (!args.includes('--passphrase-stdin')) {
      throw new Error('Give the key file passphrase on standard input with --passphrase-stdin.');
    }
    pass = await io.stdin();
    try {
      bytes = await io.readFile(file);
    } catch {
      throw new Error('The key file could not be read.');
    }
  }
  if (pass.replace(/\r?\n$/, '').length === 0) throw new Error('No passphrase on standard input.');
  return openKeyFile(bytes, pass);
}

/** Complete off-site archives, newest first. */
async function completeArchives(s3: S3Like, s: OffsiteSettings) {
  const prefix = `${s.prefix}${OFFSITE_LAYOUT.archives}`;
  const listing = [];
  for await (const o of listObjects(s3, s.bucket!, prefix)) listing.push(o);
  return archiveArtifacts(listing, prefix).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

async function readJson(
  s3: S3Like,
  bucket: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const j: unknown = JSON.parse((await getSmall(s3, bucket, key)).toString('utf8'));
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sidecarKey(s: OffsiteSettings, archiveId: string): string {
  return `${s.prefix}${OFFSITE_LAYOUT.archives}${archiveId}.json`;
}

async function cmdList(io: CliIo, now: Date) {
  const s = await settingsFrom(io);
  const s3 = io.offsite(s);
  result(io, 'prefix', s.prefix);
  const archives = await completeArchives(s3, s);
  const runs = await new OffsiteMirror(null, null).listRuns(s3, s);
  // Without the key file the signatures cannot be checked here; list
  // says which copies carry one. The restore checks them.
  const signedBy = async (marker: string): Promise<string | null> => {
    const j = await readJson(s3, s.bucket!, marker);
    const sig = j?.signature as { verifyKey?: unknown } | undefined;
    if (!sig) return null;
    return typeof sig.verifyKey === 'string' && FINGERPRINT_RE.test(sig.verifyKey)
      ? sig.verifyKey
      : 'damaged';
  };
  const state = (a: { complete: boolean; createdAt: Date; lastModified?: Date | null }) =>
    suspectDate({ id: '', ...a }, now) ? 'set aside' : a.complete ? 'ok        ' : 'unfinished';
  const line = async (a: OffsiteArtifact, label: string, marker: string) => {
    let sig = '';
    if (a.complete) {
      const by = await signedBy(marker);
      a.trust = by && by !== 'damaged' ? 'verified' : 'unsigned';
      sig = by ? `  signed ${by}` : '  NOT SIGNED';
    }
    io.err(`${state(a)}  ${a.createdAt.toISOString()}  ${label}${sig}`);
  };
  for (const a of archives) await line(a, a.id.replace(/\.enc$/, ''), sidecarKey(s, a.id));
  for (const r of runs) {
    await line(
      r,
      `mirror:${r.id}`,
      `${s.prefix}${OFFSITE_LAYOUT.mirrorRuns}${r.id}/${OFFSITE_LAYOUT.doneMarker}`,
    );
  }
  if ([...archives, ...runs].some((a) => suspectDate(a, now))) {
    io.err(
      '"set aside": dated in the future or after the provider recorded the upload. Never picked as the newest; name it to use it.',
    );
  }
  io.err(
    'Signatures are checked against the verify keys in your key file when you restore; list does not check them.',
  );
  const newest = newestGood(archives, now);
  if (newest) result(io, 'latest', newest.id.replace(/\.enc$/, ''));
  const newestMirror = newestGood(runs, now);
  if (newestMirror) result(io, 'latestMirror', newestMirror.id);
  if (!newest && !newestMirror) io.err('No complete off-site copy was found under this prefix.');
}

/** The copy a restore uses, with what the admin should see before confirming. */
interface ChosenCopy {
  kind: 'archive' | 'mirror';
  name: string;
  createdAt: Date;
  uploadedAt: Date | null;
  bytes: number;
  fingerprint: string;
  suspect: string | null;
  check: CopyCheck;
  /**
   * The signed manifest, when the signature verified with a key in the
   * key file (verified or foreign). Every size and SHA-256 check uses
   * it; then nothing unsigned is used for integrity.
   */
  signed: SignedManifest | null;
  /** The sidecar or done marker, as read. Only its signed manifest is trusted. */
  marker: Record<string, unknown> | null;
}

/** A signature that verified with a key in the key file. */
function signedManifest(check: CopyCheck): SignedManifest | null {
  return check.trust === 'verified' || check.trust === 'foreign' ? check.manifest : null;
}

/**
 * Install ids the folder is expected to hold copies from: the one in
 * its marker, and those it was taken over from.
 */
async function folderInstallIds(s3: S3Like, s: OffsiteSettings): Promise<string[]> {
  const j = await readJson(s3, s.bucket!, `${s.prefix}${OFFSITE_LAYOUT.installMarker}`);
  if (!j) return [];
  const ids: unknown[] = [
    j.installId,
    j.takenOverFrom,
    ...(Array.isArray(j.previousInstallIds) ? j.previousInstallIds.slice(0, 50) : []),
  ];
  return ids.filter((x): x is string => typeof x === 'string' && x.length === 36);
}

async function checkCopy(
  s3: S3Like,
  s: OffsiteSettings,
  kind: 'archive' | 'mirror',
  a: OffsiteArtifact & { sealedBytes: number | null },
  key: OffsiteKeyFile,
  installIds: string[],
): Promise<{ check: CopyCheck; marker: Record<string, unknown> | null }> {
  if (kind === 'mirror') {
    const r = await new OffsiteMirror(null, null).checkRun(s3, s, a.id, key.verifyKeys, installIds);
    return { check: r.check, marker: r.done };
  }
  const marker = await readJson(s3, s.bucket!, sidecarKey(s, a.id));
  if (!marker) {
    return {
      check: {
        trust: 'bad',
        manifest: null,
        signer: null,
        reason: 'The sidecar could not be read.',
      },
      marker: null,
    };
  }
  return {
    check: checkSignature(marker, key.verifyKeys, {
      kind: 'archive',
      prefix: s.prefix,
      name: `${OFFSITE_LAYOUT.archives}${a.id}`,
      bytes: a.sealedBytes,
      installIds,
    }),
    marker,
  };
}

const TRUST_WORDS: Readonly<Record<CopyTrust, string>> = {
  verified: 'verified',
  unsigned: 'NOT SIGNED',
  untrusted: 'SIGNER NOT CHECKED: it names a verify key that is not in the key file',
  foreign: 'SIGNED FOR ANOTHER PORTAL INSTALL',
  bad: 'BAD SIGNATURE',
};

/** Order of preference when no copy is verified. */
const FALLBACK_ORDER: readonly AllowedState[] = ['foreign', 'untrusted', 'unsigned'];

function isAllowedState(t: CopyTrust): t is AllowedState {
  return t === 'foreign' || t === 'untrusted' || t === 'unsigned';
}

function needFlag(state: AllowedState, what: string): UnverifiedCopyError {
  return new UnverifiedCopyError(
    `${what} (${TRUST_WORDS[state]}). To restore it anyway, pass ${ALLOW_FLAGS[state]}.`,
    state,
  );
}

async function chooseCopy(
  s: OffsiteSettings,
  s3: S3Like,
  args: string[],
  now: Date,
  key: OffsiteKeyFile,
  err: (line: string) => void,
): Promise<ChosenCopy> {
  const wantedArchive = arg(args, '--name');
  const wantedRun = arg(args, '--run');
  const allowed = (t: AllowedState) => args.includes(ALLOW_FLAGS[t]);
  if (wantedArchive !== null && wantedRun !== null)
    throw new Error('Give --name or --run, not both.');
  if (wantedArchive !== null && !ARCHIVE_NAME_RE.test(wantedArchive))
    throw new Error('--name must be an archive name such as backup-...tar.gz');
  if (wantedRun !== null && !MIRROR_RUN_RE.test(wantedRun))
    throw new Error('--run must be a mirror run name as list prints it (without mirror:).');
  if (key.verifyKeys.length === 0) {
    err(
      'The key file holds no verify key yet, so no signature can be checked. Add the verify key shown on Admin, Backup with: node offsite-key.mjs trust',
    );
  }
  const installIds = await folderInstallIds(s3, s);
  const archives = (await completeArchives(s3, s)).filter((a) => a.complete);
  const runs =
    wantedArchive === null
      ? (await new OffsiteMirror(null, null).listRuns(s3, s)).filter((r) => r.complete)
      : [];
  type Candidate = {
    kind: 'archive' | 'mirror';
    a: OffsiteArtifact & { sealedBytes: number | null };
  };
  let pick: Candidate | null = null;
  type Checked = { check: CopyCheck; marker: Record<string, unknown> | null };
  let checked: Checked | null = null;
  if (wantedArchive !== null) {
    const a = archives.find((x) => x.id === `${wantedArchive}${OFFSITE_LAYOUT.sealed}`);
    if (!a) throw new Error(`No complete off-site copy named ${wantedArchive}.`);
    pick = { kind: 'archive', a };
  } else if (wantedRun !== null) {
    const r = runs.find((x) => x.id === wantedRun);
    if (!r) throw new Error(`No complete mirror run named ${wantedRun}.`);
    pick = { kind: 'mirror', a: r };
  } else {
    // Newest first, either kind; dates that cannot be trusted never
    // make a copy the newest. The first verified copy wins. Without
    // one, the newest copy of the most trustworthy other state is
    // offered, and used only with that state's flag.
    const all: Candidate[] = [
      ...archives.map((a) => ({ kind: 'archive' as const, a })),
      ...runs.map((a) => ({ kind: 'mirror' as const, a })),
    ]
      .filter((c) => !suspectDate(c.a, now))
      .sort((x, y) => y.a.createdAt.getTime() - x.a.createdAt.getTime());
    if (all.length === 0) throw new Error('No complete off-site copy was found.');
    const fallback = new Map<AllowedState, { c: Candidate; checked: Checked }>();
    for (const c of all) {
      const r = await checkCopy(s3, s, c.kind, c.a, key, installIds);
      const label = c.kind === 'archive' ? c.a.id.replace(/\.enc$/, '') : `mirror:${c.a.id}`;
      if (r.check.trust === 'verified') {
        pick = c;
        checked = r;
        break;
      }
      err(`Skipped ${label}: ${TRUST_WORDS[r.check.trust]}. ${r.check.reason ?? ''}`.trim());
      const t = r.check.trust;
      if (isAllowedState(t) && !fallback.has(t)) fallback.set(t, { c, checked: r });
    }
    if (!pick) {
      const state = FALLBACK_ORDER.find((t) => fallback.has(t));
      if (!state) throw new Error('No off-site copy with a good signature was found.');
      const f = fallback.get(state)!;
      if (!allowed(state)) throw needFlag(state, 'No verified copy was found. The best one left');
      pick = f.c;
      checked = f.checked;
    }
  }
  if (!checked) checked = await checkCopy(s3, s, pick.kind, pick.a, key, installIds);
  const check = checked.check;
  if (check.trust === 'bad') {
    throw new Error(
      `Refusing this copy: ${check.reason ?? 'its signature does not verify.'} It was not made by your portal as it is, so it is never restored.`,
    );
  }
  if (isAllowedState(check.trust) && !allowed(check.trust)) {
    throw needFlag(check.trust, `This copy is not verified. ${check.reason ?? ''}`.trim());
  }
  const m = signedManifest(check);
  let fingerprint = 'unknown';
  if (m) fingerprint = m.key;
  else {
    const fp = checked.marker?.keyFingerprint;
    if (typeof fp === 'string' && FINGERPRINT_RE.test(fp)) fingerprint = fp;
  }
  const signedCreated = m ? new Date(m.created) : null;
  return {
    kind: pick.kind,
    name: pick.kind === 'archive' ? pick.a.id.replace(/\.enc$/, '') : pick.a.id,
    createdAt: signedCreated ?? pick.a.createdAt,
    uploadedAt: pick.a.lastModified ?? null,
    bytes: pick.a.sealedBytes ?? 0,
    fingerprint,
    suspect: suspectDate(pick.a, now),
    check,
    signed: m,
    marker: checked.marker,
  };
}

/** What was and was not checked for the chosen copy, in plain words. */
export function checkedLines(c: Pick<ChosenCopy, 'check' | 'signed'>): string[] {
  const sig = c.check.signer ?? 'unknown';
  switch (c.check.trust) {
    case 'verified':
      return [
        `Signature: verified with the verify key ${sig} in your key file, for the portal install ${c.signed?.install.slice(0, 8) ?? '?'} this folder belongs to.`,
        'Checked: the size and SHA-256 of every downloaded file, against the signed record, before it is decrypted.',
      ];
    case 'foreign':
      return [
        `STATE: SIGNED FOR ANOTHER PORTAL INSTALL. The signature verified with the verify key ${sig} in your key file, but it names the portal install ${c.signed?.install.slice(0, 8) ?? '?'}, which is not one this folder belongs to.`,
        'Checked: the signature, and the size and SHA-256 of every downloaded file against the signed record, before it is decrypted.',
        'Not checked: that the portal this folder belongs to made this copy.',
      ];
    case 'untrusted':
      return [
        `STATE: SIGNER NOT CHECKED. The copy claims the verify key ${sig}; that claim is not checked, because your key file does not hold that key.`,
        'Not checked: who made this copy. Nothing proves your portal made it.',
        'Checked only against unsigned records in the bucket: the size and SHA-256 of the downloaded files. That catches damage, not a deliberate change.',
      ];
    case 'unsigned':
      return [
        'STATE: NOT SIGNED. The copy carries no signature.',
        'Not checked: who made this copy. Nothing proves your portal made it.',
        'Checked only against unsigned records in the bucket, where there are any: the size and SHA-256 of the downloaded files. That catches damage, not a deliberate change.',
      ];
    default:
      return ['STATE: BAD SIGNATURE. This copy is never used.'];
  }
}

function printCopy(io: CliIo, c: ChosenCopy) {
  result(io, 'kind', c.kind);
  result(io, 'name', c.name);
  result(io, 'created', c.createdAt.toISOString());
  result(io, 'uploaded', c.uploadedAt ? c.uploadedAt.toISOString() : 'unknown');
  result(io, 'bytes', c.bytes);
  result(io, 'fingerprint', c.fingerprint);
  result(io, 'signature', c.check.trust);
  // A signer is named as checked only when its signature verified.
  if (c.signed && c.check.signer) result(io, 'signedBy', c.check.signer);
  else if (c.check.trust === 'untrusted' && c.check.signer)
    result(io, 'claimedSigner', c.check.signer);
  if (c.signed) result(io, 'install', c.signed.install);
  if (c.suspect) result(io, 'suspect', c.suspect);
  for (const line of checkedLines(c)) io.err(line);
}

async function cmdDescribe(io: CliIo, args: string[], now: Date) {
  const key = await privateKeyFrom(io, args);
  const s = await settingsFrom(io);
  const c = await chooseCopy(s, io.offsite(s), args, now, key, io.err);
  result(io, 'prefix', s.prefix);
  printCopy(io, c);
}

/** The download goes ahead only for the copy the admin confirmed by name. */
function assertConfirmed(args: string[], c: ChosenCopy) {
  const confirmed = arg(args, '--confirm-copy');
  if (confirmed !== c.name) {
    throw new Error(
      `Confirm the copy first: check it with describe, then pass --confirm-copy ${c.name}. Nothing was downloaded.`,
    );
  }
}

async function cmdCheckKey(io: CliIo, args: string[]) {
  const key = await privateKeyFrom(io, args);
  result(io, 'fingerprint', key.publicKey.fingerprintText);
  result(io, 'verifyKeys', key.verifyKeys.length);
  for (const v of key.verifyKeys) result(io, 'verifyKey', v.fingerprintText);
}

/** The encryption key a copy names must be the key file's. */
function assertKeyMatches(c: ChosenCopy, key: OffsiteKeyFile) {
  if (c.fingerprint !== 'unknown' && c.fingerprint !== key.publicKey.fingerprintText) {
    throw new Error(
      `This copy was encrypted for the key with fingerprint ${c.fingerprint}; the key file given is ${key.publicKey.fingerprintText}. Use the key that was in effect when the copy was made.`,
    );
  }
}

async function cmdFetch(io: CliIo, args: string[], now: Date) {
  const outDir = arg(args, '--out');
  if (!outDir) throw new Error('--out is required.');
  if (arg(args, '--run') !== null)
    throw new Error('fetch takes --name; use fetch-mirror for --run.');
  const key = await privateKeyFrom(io, args);
  const s = await settingsFrom(io);
  const s3 = io.offsite(s);
  // Checked again here, not taken from an earlier describe: the bucket
  // may have changed since.
  const chosen = await chooseCopy(s, s3, args, now, key, io.err);
  if (chosen.kind !== 'archive') {
    throw new Error(`The newest copy is the mirror run ${chosen.name}; use fetch-mirror.`);
  }
  printCopy(io, chosen);
  assertConfirmed(args, chosen);
  assertKeyMatches(chosen, key);
  const name = chosen.name;
  const objectKey = `${s.prefix}${OFFSITE_LAYOUT.archives}${name}${OFFSITE_LAYOUT.sealed}`;
  // With a signature that verified (verified or foreign), only the
  // signed record is used. Without one, the sidecar's own checksum
  // still catches damage, though not a deliberate change.
  const m = chosen.signed as ArchiveManifest | null;
  const side = m ? {} : (chosen.marker ?? {});
  const sideSha =
    typeof side.sealedSha256 === 'string' && /^[0-9a-f]{64}$/.test(side.sealedSha256)
      ? side.sealedSha256
      : null;
  const sideBytes = typeof side.sealedBytes === 'number' ? side.sealedBytes : null;
  const expect = m
    ? { bytes: Number(m.bytes), sha256: m.sha256 }
    : sideSha
      ? { bytes: sideBytes, sha256: sideSha }
      : null;
  const sealedBytes = m ? Number(m.bytes) : (sideBytes ?? chosen.bytes);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  // The encrypted copy is kept until it verified and decrypted.
  await assertFree(outDir, 2 * sealedBytes);
  io.err(`Downloading ${name}, checking it against its signed record, then decrypting...`);
  await fetchChecked(s3, s.bucket!, objectKey, path.join(outDir, name), expect, key);
  const finalPath = path.join(outDir, name);
  const manifest = await readManifest(finalPath);
  result(io, 'archive', finalPath);
  result(io, 'database', manifest.database);
  result(io, 'objects', manifest.objects);
  if (manifest.portalVersion) result(io, 'portalVersion', manifest.portalVersion);
}

async function cmdFetchMirror(io: CliIo, args: string[], now: Date) {
  if (arg(args, '--name') !== null) {
    throw new Error('fetch-mirror takes --run; use fetch for --name.');
  }
  const key = await privateKeyFrom(io, args);
  const s = await settingsFrom(io);
  const chosen = await chooseCopy(s, io.offsite(s), args, now, key, io.err);
  if (chosen.kind !== 'mirror') {
    throw new Error(`The newest copy is the archive ${chosen.name}; use fetch.`);
  }
  printCopy(io, chosen);
  assertConfirmed(args, chosen);
  assertKeyMatches(chosen, key);
  await new OffsiteMirror(null, null).cliFetch(
    io,
    args,
    s,
    key,
    chosen.name,
    chosen.signed as MirrorManifest | null,
    chosen.signed ? null : chosen.marker,
  );
}

async function cmdPutMirrorObjects(io: CliIo, args: string[], now: Date) {
  if (arg(args, '--run') === null) throw new Error('--run is required.');
  const key = await privateKeyFrom(io, args);
  const s = await settingsFrom(io);
  const chosen = await chooseCopy(s, io.offsite(s), args, now, key, io.err);
  assertKeyMatches(chosen, key);
  await new OffsiteMirror(null, null).cliPutObjects(
    io,
    s,
    key,
    chosen.name,
    chosen.signed as MirrorManifest | null,
    arg(args, '--work') ?? os.tmpdir(),
  );
}

async function readManifest(archive: string) {
  const buf = await readTarEntry(archive, 'manifest.json');
  if (!buf) throw new Error('The archive has no manifest.json.');
  const m = JSON.parse(buf.toString('utf8')) as {
    databases?: unknown;
    minio?: { objectCount?: unknown };
    portalVersion?: unknown;
  };
  const database =
    Array.isArray(m.databases) && typeof m.databases[0] === 'string' ? m.databases[0] : 'gratisgis';
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(database))
    throw new Error('The archive names an unexpected database.');
  const objects = typeof m.minio?.objectCount === 'number' ? m.minio.objectCount : 0;
  const portalVersion =
    typeof m.portalVersion === 'string' && SAFE_VALUE.test(m.portalVersion)
      ? m.portalVersion
      : null;
  return { database, objects, portalVersion };
}

async function assertFree(dir: string, bytes: number) {
  try {
    const st = await fs.statfs(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const need = Math.ceil(bytes * 1.05) + 64 * 1024 * 1024;
    if (need > free) {
      throw new Error(
        `Not enough disk: this needs about ${Math.ceil(need / 1024 ** 3)} GB and ${dir} has ${Math.floor(free / 1024 ** 3)} GB free.`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Not enough disk')) throw e;
    // A failed probe does not block the restore.
  }
}

async function cmdPutObjects(io: CliIo, args: string[]) {
  const archive = arg(args, '--archive');
  if (!archive) throw new Error('--archive is required.');
  const { s3, bucket } = io.local();
  const size = (await fs.stat(archive)).size;
  await assertFree(path.dirname(archive), size);
  const stage = await fs.mkdtemp(path.join(path.dirname(archive), '.offsite-objects-'));
  try {
    io.err('Unpacking the stored files...');
    await extractTarGz(archive, stage);
    let types: Record<string, string> = {};
    try {
      const meta = JSON.parse(await fs.readFile(path.join(stage, MINIO_META_MEMBER), 'utf8')) as {
        contentTypes?: Record<string, string>;
      };
      types = meta.contentTypes ?? {};
    } catch {
      // Older archives have no metadata; the store guesses.
    }
    const root = path.join(stage, 'minio');
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          const key = path.relative(root, full).split(path.sep).join('/');
          // Size from the open file, not a separate stat of the path.
          const fh = await fs.open(full, 'r');
          try {
            const st = await fh.stat();
            await s3.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: fh.createReadStream({ autoClose: false }),
                ContentLength: st.size,
                ContentType: types[key] ?? 'application/octet-stream',
              }),
            );
          } finally {
            await fh.close();
          }
          count += 1;
          if (count % 500 === 0) io.err(`  ${count} files put back...`);
        }
      }
    };
    await walk(root);
    result(io, 'objects', count);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function cmdCountObjects(io: CliIo) {
  const { s3, bucket } = io.local();
  let count = 0;
  let token: string | undefined;
  do {
    const page = (await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ...(token ? { ContinuationToken: token } : {}) }),
    )) as { Contents?: unknown[]; IsTruncated?: boolean; NextContinuationToken?: string };
    count += page.Contents?.length ?? 0;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  result(io, 'objects', count);
}

export async function runCli(argv: string[], io: CliIo, now = new Date()): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'list':
        await cmdList(io, now);
        return 0;
      case 'describe':
        await cmdDescribe(io, args, now);
        return 0;
      case 'check-key':
        await cmdCheckKey(io, args);
        return 0;
      case 'fetch':
        await cmdFetch(io, args, now);
        return 0;
      case 'fetch-mirror':
        await cmdFetchMirror(io, args, now);
        return 0;
      case 'put-objects':
        await cmdPutObjects(io, args);
        return 0;
      case 'put-mirror-objects':
        await cmdPutMirrorObjects(io, args, now);
        return 0;
      case 'count-objects':
        await cmdCountObjects(io);
        return 0;
      default:
        io.err(
          'usage: offsite-cli.js list | describe | check-key | fetch | fetch-mirror | put-objects | put-mirror-objects | count-objects',
        );
        return 2;
    }
  } catch (e) {
    const msg = describeS3Error(e);
    io.err(`offsite: ${msg}`);
    if (e instanceof UnverifiedCopyError) {
      // Tells the restore script which state to ask about.
      io.out(`needs=${e.state}`);
      return EXIT_UNVERIFIED;
    }
    return 1;
  }
}

/* istanbul ignore next: process wiring */
if (require.main === module) {
  const readStdin = async () => {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of process.stdin) {
      n += (c as Buffer).length;
      if (n > 16 * 1024) throw new Error('Standard input is too long for a key and passphrase.');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const minio = () => {
    const env = process.env;
    return {
      s3: new S3Client({
        region: 'us-east-1',
        endpoint: env.MINIO_ENDPOINT ?? 'http://localhost:9000',
        credentials: {
          accessKeyId: env.MINIO_ACCESS_KEY ?? '',
          secretAccessKey: env.MINIO_SECRET_KEY ?? '',
        },
        forcePathStyle: true,
      }),
      bucket: env.MINIO_BUCKET ?? 'gratisgis',
    };
  };
  void runCli(process.argv.slice(2), {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    stdin: readStdin,
    env: (n) => process.env[n],
    readFile: (p) => fs.readFile(p),
    offsite: createOffsiteClient,
    local: minio,
  }).then((code) => {
    process.exitCode = code;
  });
}
