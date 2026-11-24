// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Command line helper for restoring from off-site copies on a server
 * that has no working portal yet. infra/restore-from-offsite.sh runs it
 * inside the portal-api image:
 *
 *   node dist/backup/offsite-cli.js list
 *   node dist/backup/offsite-cli.js fetch --passphrase-stdin --out DIR [--name ARCHIVE]
 *   node dist/backup/offsite-cli.js put-objects --archive FILE
 *   node dist/backup/offsite-cli.js count-objects
 *
 * Bucket settings come from the BACKUP_OFFSITE_* variables; the local
 * object store from MINIO_*. The passphrase is read from standard
 * input, never from an argument. Results are printed as key=value
 * lines on stdout for the script; progress goes to stderr.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { resolveOffsiteSettings, type OffsiteRow, type OffsiteSettings } from './offsite-config.js';
import { SealKeyCache, unsealStream } from './offsite-crypto.js';
import { archiveArtifacts, OFFSITE_LAYOUT } from './offsite-rules.js';
import {
  createOffsiteClient,
  describeS3Error,
  getObjectStream,
  getSmall,
  listObjects,
  type S3Like,
} from './offsite-store.js';
import { extractTarGz, readTarEntry } from './tar-cli.js';
import { OffsiteMirror } from './offsite-mirror.js';

/** Same name as backup.service.ts; not imported, to keep Nest out of the CLI. */
const MINIO_META_MEMBER = 'minio-meta.json';
const ARCHIVE_NAME = /^backup-[0-9A-Za-z-]+\.tar\.gz$/;
const SAFE_VALUE = /^[A-Za-z0-9._:/@+-]{0,300}$/;

const EMPTY_ROW: OffsiteRow = {
  offsiteEnabled: null,
  offsiteEndpoint: null,
  offsiteRegion: null,
  offsiteBucket: null,
  offsitePrefix: null,
  offsitePathStyle: null,
  offsiteAccessKeyId: null,
  offsiteRetentionDays: null,
  offsiteAlertDays: null,
  offsiteMirrorThresholdBytes: null,
};

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: () => Promise<string>;
  env: (name: string) => string | undefined;
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

async function settingsFrom(io: CliIo, needPassphrase: boolean): Promise<OffsiteSettings> {
  let passphrase: string | null = null;
  if (needPassphrase) {
    passphrase = (await io.stdin()).replace(/\r?\n$/, '');
    if (passphrase.length === 0) throw new Error('No passphrase on standard input.');
  }
  const s = resolveOffsiteSettings(
    EMPTY_ROW,
    { secretFromDb: null, passphraseFromDb: passphrase },
    io.env,
  );
  const missing = [
    !s.endpoint && 'BACKUP_OFFSITE_ENDPOINT',
    !s.bucket && 'BACKUP_OFFSITE_BUCKET',
    !s.accessKeyId && 'BACKUP_OFFSITE_ACCESS_KEY_ID',
    !s.secretAccessKey && 'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Set these in the env file: ${missing.join(', ')}.`);
  return s;
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

async function cmdList(io: CliIo) {
  const s = await settingsFrom(io, false);
  const s3 = io.offsite(s);
  const archives = await completeArchives(s3, s);
  for (const a of archives) {
    io.err(
      `${a.complete ? 'ok        ' : 'unfinished'}  ${a.createdAt.toISOString()}  ${a.id.replace(/\.enc$/, '')}`,
    );
  }
  const runs = await new OffsiteMirror(null, null).listRuns(s3, s);
  for (const r of runs) {
    io.err(
      `${r.complete ? 'ok        ' : 'unfinished'}  ${r.createdAt.toISOString()}  mirror:${r.id}`,
    );
  }
  const newest = archives.find((a) => a.complete);
  if (newest) result(io, 'latest', newest.id.replace(/\.enc$/, ''));
  const newestMirror = runs.find((r) => r.complete);
  if (newestMirror) result(io, 'latestMirror', newestMirror.id);
  if (!newest && !newestMirror) io.err('No complete off-site copy was found under this prefix.');
}

async function cmdFetch(io: CliIo, args: string[]) {
  const outDir = arg(args, '--out');
  if (!outDir) throw new Error('--out is required.');
  const wanted = arg(args, '--name');
  if (wanted !== null && !ARCHIVE_NAME.test(wanted))
    throw new Error('--name must be an archive name such as backup-...tar.gz');
  const s = await settingsFrom(io, true);
  const s3 = io.offsite(s);
  const archives = (await completeArchives(s3, s)).filter((a) => a.complete);
  const pick = wanted ? archives.find((a) => a.id === `${wanted}.enc`) : archives[0];
  if (!pick) {
    throw new Error(
      wanted
        ? `No complete off-site copy named ${wanted}.`
        : 'No complete off-site copy was found.',
    );
  }
  const name = pick.id.replace(/\.enc$/, '');
  const key = `${s.prefix}${OFFSITE_LAYOUT.archives}${pick.id}`;
  const sidecar = JSON.parse((await getSmall(s3, s.bucket!, `${key}.json`)).toString('utf8')) as {
    plainBytes?: number;
    sealedBytes?: number;
    sealedSha256?: string;
  };

  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  await assertFree(outDir, Number(sidecar.plainBytes ?? 0));
  const finalPath = path.join(outDir, name);
  const partial = path.join(outDir, `.partial-${name}`);
  io.err(`Downloading and decrypting ${name}...`);
  const hash = createHash('sha256');
  let sealed = 0;
  const body = await getObjectStream(s3, s.bucket!, key);
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
      Readable.from(unsealStream(tap(), s.passphrase!, new SealKeyCache(1))),
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
          const st = await fs.stat(full);
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: createReadStream(full),
              ContentLength: st.size,
              ContentType: types[key] ?? 'application/octet-stream',
            }),
          );
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

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'list':
        await cmdList(io);
        return 0;
      case 'fetch':
        await cmdFetch(io, args);
        return 0;
      case 'fetch-mirror':
        await new OffsiteMirror(null, null).cliFetch(io, args, await settingsFrom(io, true));
        return 0;
      case 'put-objects':
        await cmdPutObjects(io, args);
        return 0;
      case 'put-mirror-objects':
        await new OffsiteMirror(null, null).cliPutObjects(io, args, await settingsFrom(io, true));
        return 0;
      case 'count-objects':
        await cmdCountObjects(io);
        return 0;
      default:
        io.err(
          'usage: offsite-cli.js list | fetch | fetch-mirror | put-objects | put-mirror-objects | count-objects',
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
      if (n > 4096) throw new Error('The passphrase on standard input is too long.');
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
    offsite: createOffsiteClient,
    local: minio,
  }).then((code) => {
    process.exitCode = code;
  });
}
