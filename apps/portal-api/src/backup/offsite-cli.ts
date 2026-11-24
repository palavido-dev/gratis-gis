// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Command line helper for restoring from off-site copies on a server
 * that has no working portal yet. infra/restore-from-offsite.sh runs it
 * inside the portal-api image:
 *
 *   node dist/backup/offsite-cli.js list
 *   node dist/backup/offsite-cli.js check-key --key-file F --passphrase-stdin
 *   node dist/backup/offsite-cli.js fetch --key-file F --passphrase-stdin --out DIR [--name ARCHIVE]
 *   node dist/backup/offsite-cli.js fetch-mirror --key-file F --passphrase-stdin --out DIR [--run RUN]
 *   node dist/backup/offsite-cli.js put-objects --archive FILE
 *   node dist/backup/offsite-cli.js put-mirror-objects --key-file F --passphrase-stdin [--run RUN]
 *   node dist/backup/offsite-cli.js count-objects
 *
 * Bucket settings come from the BACKUP_OFFSITE_* variables; the local
 * object store from MINIO_*. The private key file is the admin's
 * sealed key file (infra/recovery/offsite-key.mjs); its passphrase is
 * read from standard input, never from an argument, with one trailing
 * line break dropped and Unicode NFC applied. Results are printed as
 * key=value lines on stdout for the script; progress goes to stderr.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  OFFSITE_ENV,
  resolveOffsiteSettings,
  type OffsiteRow,
  type OffsiteSettings,
} from './offsite-config.js';
import { openKeyFile, unsealStream, type OffsitePrivateKey } from './offsite-crypto.js';
import { endpointPolicy } from './offsite-endpoint.js';
import { archiveArtifacts, OFFSITE_LAYOUT } from './offsite-rules.js';
import {
  createOffsiteClient,
  describeS3Error,
  getObjectStream,
  getSmall,
  listObjects,
  listPrefixes,
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

/** Bucket settings from the environment, the folder found when unset. */
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
  if (!io.env(OFFSITE_ENV.prefix)?.trim()) {
    // The default folder carries the portal's install id, which a new
    // server does not know. Find folders that hold a portal marker.
    const s3 = io.offsite(s);
    const found: string[] = [];
    for await (const p of listPrefixes(s3, s.bucket!, '')) {
      try {
        await getSmall(s3, s.bucket!, `${p}${OFFSITE_LAYOUT.installMarker}`);
        found.push(p);
      } catch {
        // Not a portal folder.
      }
    }
    if (found.length === 1) {
      s.prefix = found[0]!;
      io.err(`Using the folder ${s.prefix} (set ${OFFSITE_ENV.prefix} to choose another).`);
    } else if (found.length > 1) {
      throw new Error(
        `The bucket has several portal folders (${found.join(', ')}). Set ${OFFSITE_ENV.prefix} to the one to restore.`,
      );
    }
  }
  return s;
}

/**
 * The admin's private key: the sealed key file named by --key-file,
 * opened with the passphrase on standard input.
 */
async function privateKeyFrom(io: CliIo, args: string[]): Promise<OffsitePrivateKey> {
  const file = arg(args, '--key-file');
  if (!file) throw new Error('--key-file is required.');
  if (!args.includes('--passphrase-stdin')) {
    throw new Error('Give the key file passphrase on standard input with --passphrase-stdin.');
  }
  const pass = await io.stdin();
  if (pass.replace(/\r?\n$/, '').length === 0) throw new Error('No passphrase on standard input.');
  let bytes: Buffer;
  try {
    bytes = await io.readFile(file);
  } catch {
    throw new Error('The key file could not be read.');
  }
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

async function cmdList(io: CliIo) {
  const s = await settingsFrom(io);
  const s3 = io.offsite(s);
  result(io, 'prefix', s.prefix);
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

async function cmdCheckKey(io: CliIo, args: string[]) {
  const key = await privateKeyFrom(io, args);
  result(io, 'fingerprint', key.publicKey.fingerprintText);
}

async function cmdFetch(io: CliIo, args: string[]) {
  const outDir = arg(args, '--out');
  if (!outDir) throw new Error('--out is required.');
  const wanted = arg(args, '--name');
  if (wanted !== null && !ARCHIVE_NAME.test(wanted))
    throw new Error('--name must be an archive name such as backup-...tar.gz');
  const key = await privateKeyFrom(io, args);
  const s = await settingsFrom(io);
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
  const objectKey = `${s.prefix}${OFFSITE_LAYOUT.archives}${pick.id}`;
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

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'list':
        await cmdList(io);
        return 0;
      case 'check-key':
        await cmdCheckKey(io, args);
        return 0;
      case 'fetch':
        await cmdFetch(io, args);
        return 0;
      case 'fetch-mirror': {
        const key = await privateKeyFrom(io, args);
        await new OffsiteMirror(null, null).cliFetch(io, args, await settingsFrom(io), key);
        return 0;
      }
      case 'put-objects':
        await cmdPutObjects(io, args);
        return 0;
      case 'put-mirror-objects': {
        const key = await privateKeyFrom(io, args);
        await new OffsiteMirror(null, null).cliPutObjects(io, args, await settingsFrom(io), key);
        return 0;
      }
      case 'count-objects':
        await cmdCountObjects(io);
        return 0;
      default:
        io.err(
          'usage: offsite-cli.js list | check-key | fetch | fetch-mirror | put-objects | put-mirror-objects | count-objects',
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
    readFile: (p) => fs.readFile(p),
    offsite: createOffsiteClient,
    local: minio,
  }).then((code) => {
    process.exitCode = code;
  });
}
