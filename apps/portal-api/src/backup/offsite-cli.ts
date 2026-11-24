// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Command line helper for restoring from off-site copies on a server
 * that has no working portal yet. infra/restore-from-offsite.sh runs it
 * inside the portal-api image:
 *
 *   node dist/backup/offsite-cli.js list
 *   node dist/backup/offsite-cli.js describe [--name ARCHIVE | --run RUN]
 *   node dist/backup/offsite-cli.js check-key KEY
 *   node dist/backup/offsite-cli.js fetch KEY --out DIR --confirm-copy NAME [--name ARCHIVE]
 *   node dist/backup/offsite-cli.js fetch-mirror KEY --out DIR --confirm-copy NAME [--run RUN]
 *   node dist/backup/offsite-cli.js put-objects --archive FILE
 *   node dist/backup/offsite-cli.js put-mirror-objects KEY [--run RUN]
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
 * `describe` names the copy a restore would use (the one named, or the
 * newest complete one) with its date, size and key fingerprint, and
 * changes nothing. `fetch` and `fetch-mirror` download only when
 * --confirm-copy repeats that copy's name. A copy dated in the future
 * is never picked as the newest; it is used only when named.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  isValidOffsitePrefix,
  normalizePrefix,
  OFFSITE_ENV,
  resolveOffsiteSettings,
  type OffsiteRow,
  type OffsiteSettings,
} from './offsite-config.js';
import { openKeyFile, unsealStream, type OffsitePrivateKey } from './offsite-crypto.js';
import { endpointPolicy } from './offsite-endpoint.js';
import {
  ARCHIVE_NAME_RE,
  archiveArtifacts,
  MIRROR_RUN_RE,
  newestGood,
  OFFSITE_LAYOUT,
  suspectDate,
} from './offsite-rules.js';
import {
  createOffsiteClient,
  describeS3Error,
  getObjectStream,
  getSmall,
  listLevel,
  listObjects,
  type S3Like,
} from './offsite-store.js';
import { extractTarGz, readTarEntry } from './tar-cli.js';
import { OffsiteMirror } from './offsite-mirror.js';

/** Same name as backup.service.ts; not imported, to keep Nest out of the CLI. */
const MINIO_META_MEMBER = 'minio-meta.json';
const SAFE_VALUE = /^[A-Za-z0-9._:/@+-]{0,300}$/;
const FINGERPRINT_RE = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;
/** How deep, and through how many folders, the restore looks for a portal folder. */
const FIND_DEPTH = 4;
const FIND_FOLDERS = 200;

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
async function privateKeyFrom(io: CliIo, args: string[]): Promise<OffsitePrivateKey> {
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

async function cmdList(io: CliIo, now: Date) {
  const s = await settingsFrom(io);
  const s3 = io.offsite(s);
  result(io, 'prefix', s.prefix);
  const archives = await completeArchives(s3, s);
  const state = (a: { complete: boolean; createdAt: Date; lastModified?: Date | null }) =>
    suspectDate({ id: '', ...a }, now) ? 'set aside' : a.complete ? 'ok        ' : 'unfinished';
  for (const a of archives) {
    io.err(`${state(a)}  ${a.createdAt.toISOString()}  ${a.id.replace(/\.enc$/, '')}`);
  }
  const runs = await new OffsiteMirror(null, null).listRuns(s3, s);
  for (const r of runs) {
    io.err(`${state(r)}  ${r.createdAt.toISOString()}  mirror:${r.id}`);
  }
  if ([...archives, ...runs].some((a) => suspectDate(a, now))) {
    io.err(
      '"set aside": dated in the future or after the provider recorded the upload. Never picked as the newest; name it to use it.',
    );
  }
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
}

async function chooseCopy(
  s: OffsiteSettings,
  s3: S3Like,
  args: string[],
  now: Date,
): Promise<ChosenCopy> {
  const wantedArchive = arg(args, '--name');
  const wantedRun = arg(args, '--run');
  if (wantedArchive !== null && wantedRun !== null)
    throw new Error('Give --name or --run, not both.');
  if (wantedArchive !== null && !ARCHIVE_NAME_RE.test(wantedArchive))
    throw new Error('--name must be an archive name such as backup-...tar.gz');
  if (wantedRun !== null && !MIRROR_RUN_RE.test(wantedRun))
    throw new Error('--run must be a mirror run name as list prints it (without mirror:).');
  const archives = (await completeArchives(s3, s)).filter((a) => a.complete);
  const runs =
    wantedArchive === null
      ? (await new OffsiteMirror(null, null).listRuns(s3, s)).filter((r) => r.complete)
      : [];
  let kind: 'archive' | 'mirror';
  let pick: (typeof archives)[number] | (typeof runs)[number] | null;
  if (wantedArchive !== null) {
    kind = 'archive';
    pick = archives.find((a) => a.id === `${wantedArchive}${OFFSITE_LAYOUT.sealed}`) ?? null;
    if (!pick) throw new Error(`No complete off-site copy named ${wantedArchive}.`);
  } else if (wantedRun !== null) {
    kind = 'mirror';
    pick = runs.find((r) => r.id === wantedRun) ?? null;
    if (!pick) throw new Error(`No complete mirror run named ${wantedRun}.`);
  } else {
    const a = newestGood(archives, now);
    const r = newestGood(runs, now);
    if (!a && !r) throw new Error('No complete off-site copy was found.');
    if (r && (!a || r.createdAt > a.createdAt)) {
      kind = 'mirror';
      pick = r;
    } else {
      kind = 'archive';
      pick = a;
    }
  }
  const marker =
    kind === 'archive'
      ? `${s.prefix}${OFFSITE_LAYOUT.archives}${pick!.id}.json`
      : `${s.prefix}${OFFSITE_LAYOUT.mirrorRuns}${pick!.id}/${OFFSITE_LAYOUT.doneMarker}`;
  let fingerprint = 'unknown';
  try {
    const j = JSON.parse((await getSmall(s3, s.bucket!, marker)).toString('utf8')) as {
      keyFingerprint?: unknown;
    };
    if (typeof j.keyFingerprint === 'string' && FINGERPRINT_RE.test(j.keyFingerprint)) {
      fingerprint = j.keyFingerprint;
    }
  } catch {
    // Shown as unknown; decrypting still checks the key.
  }
  return {
    kind,
    name: kind === 'archive' ? pick!.id.replace(/\.enc$/, '') : pick!.id,
    createdAt: pick!.createdAt,
    uploadedAt: pick!.lastModified ?? null,
    bytes:
      kind === 'archive'
        ? ((pick as (typeof archives)[number]).sealedBytes ?? 0)
        : (pick as (typeof runs)[number]).sealedBytes,
    fingerprint,
    suspect: suspectDate(pick!, now),
  };
}

function printCopy(io: CliIo, c: ChosenCopy) {
  result(io, 'kind', c.kind);
  result(io, 'name', c.name);
  result(io, 'created', c.createdAt.toISOString());
  result(io, 'uploaded', c.uploadedAt ? c.uploadedAt.toISOString() : 'unknown');
  result(io, 'bytes', c.bytes);
  result(io, 'fingerprint', c.fingerprint);
  if (c.suspect) result(io, 'suspect', c.suspect);
}

async function cmdDescribe(io: CliIo, args: string[], now: Date) {
  const s = await settingsFrom(io);
  const c = await chooseCopy(s, io.offsite(s), args, now);
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
}

async function cmdFetch(io: CliIo, args: string[], now: Date) {
  const outDir = arg(args, '--out');
  if (!outDir) throw new Error('--out is required.');
  if (arg(args, '--run') !== null)
    throw new Error('fetch takes --name; use fetch-mirror for --run.');
  const key = await privateKeyFrom(io, args);
  const s = await settingsFrom(io);
  const s3 = io.offsite(s);
  const chosen = await chooseCopy(s, s3, args, now);
  if (chosen.kind !== 'archive') {
    throw new Error(`The newest copy is the mirror run ${chosen.name}; use fetch-mirror.`);
  }
  printCopy(io, chosen);
  assertConfirmed(args, chosen);
  const name = chosen.name;
  const objectKey = `${s.prefix}${OFFSITE_LAYOUT.archives}${name}${OFFSITE_LAYOUT.sealed}`;
  const sidecar = JSON.parse(
    (await getSmall(s3, s.bucket!, `${objectKey}.json`)).toString('utf8'),
  ) as {
    plainBytes?: number;
    sealedBytes?: number;
    sealedSha256?: string;
    keyFingerprint?: string;
  };
  if (sidecar.keyFingerprint && sidecar.keyFingerprint !== key.publicKey.fingerprintText) {
    throw new Error(
      `This copy was encrypted for the key with fingerprint ${sidecar.keyFingerprint}; the key file given is ${key.publicKey.fingerprintText}. Use the key that was in effect when the copy was made.`,
    );
  }

  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  await assertFree(outDir, Number(sidecar.plainBytes ?? 0));
  const finalPath = path.join(outDir, name);
  const partial = path.join(outDir, `.partial-${name}`);
  // A run stopped half way leaves this behind; never fail on it.
  await fs.rm(partial, { force: true });
  io.err(`Downloading and decrypting ${name}...`);
  const hash = createHash('sha256');
  let sealed = 0;
  const body = await getObjectStream(s3, s.bucket!, objectKey);
  async function* tap(): AsyncGenerator<Buffer> {
    for await (const c of body) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
      hash.update(b);
      sealed += b.length;
      yield b;
    }
  }
  try {
    await pipeline(
      Readable.from(unsealStream(tap(), key)),
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
    );
    const digest = hash.digest('hex');
    if (sidecar.sealedBytes !== undefined && sidecar.sealedBytes !== sealed) {
      throw new Error(`Downloaded ${sealed} bytes; the copy should be ${sidecar.sealedBytes}.`);
    }
    if (sidecar.sealedSha256 && sidecar.sealedSha256 !== digest) {
      throw new Error(
        'The downloaded copy does not match the checksum recorded when it was uploaded.',
      );
    }
    await fs.rename(partial, finalPath);
  } catch (e) {
    await fs.rm(partial, { force: true });
    throw e;
  }
  const manifest = await readManifest(finalPath);
  result(io, 'archive', finalPath);
  result(io, 'database', manifest.database);
  result(io, 'objects', manifest.objects);
  if (manifest.portalVersion) result(io, 'portalVersion', manifest.portalVersion);
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
      case 'fetch-mirror': {
        if (arg(args, '--name') !== null) {
          throw new Error('fetch-mirror takes --run; use fetch for --name.');
        }
        const key = await privateKeyFrom(io, args);
        const s = await settingsFrom(io);
        const chosen = await chooseCopy(s, io.offsite(s), args, now);
        if (chosen.kind !== 'mirror') {
          throw new Error(`The newest copy is the archive ${chosen.name}; use fetch.`);
        }
        printCopy(io, chosen);
        assertConfirmed(args, chosen);
        const rest = args.filter((a, i) => a !== '--run' && args[i - 1] !== '--run');
        await new OffsiteMirror(null, null).cliFetch(io, [...rest, '--run', chosen.name], s, key);
        return 0;
      }
      case 'put-objects':
        await cmdPutObjects(io, args);
        return 0;
      case 'put-mirror-objects': {
        if (arg(args, '--run') === null) throw new Error('--run is required.');
        const key = await privateKeyFrom(io, args);
        await new OffsiteMirror(null, null).cliPutObjects(io, args, await settingsFrom(io), key);
        return 0;
      }
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
