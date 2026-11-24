// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { BackupService } from './backup.service.js';
import { MaintenanceModeService } from './maintenance-mode.service.js';
import { readTarEntry, streamTarEntry } from './tar-cli.js';

/** Scratch databases are named this way and nothing else is dropped. */
export const SCRATCH_PREFIX = 'gg_restore_test_';
const SCRATCH_RE = /^gg_restore_test_[0-9a-f]{16}$/;

/** A test still "running" after this long belongs to a dead process. */
const STALE_TEST_MS = 6 * 60 * 60 * 1000;

/** Row counts the test reads from the scratch copy. Fixed SQL. */
const SANITY_QUERIES: Record<string, string> = {
  organizations: 'SELECT count(*) FROM organization',
  users: 'SELECT count(*) FROM "user"',
  items: 'SELECT count(*) FROM item',
  migrations:
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
};

export interface SanityCounts {
  organizations: number;
  users: number;
  items: number;
  migrations: number;
}

/**
 * Judge the counts read from a scratch restore. A dump that restored
 * without error but holds no organization or no migration history is
 * not a backup anyone could bring a portal back from.
 */
export function judgeSanity(c: SanityCounts): string | null {
  if (!(c.migrations > 0)) return 'The restored database has no migration history.';
  if (!(c.organizations > 0)) return 'The restored database has no organization.';
  return null;
}

const LIBPQ_PARAMS: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  host: 'PGHOST',
};

/**
 * libpq environment for the portal's database URL. The client tools
 * read the password from PGPASSWORD, so it never appears in a command
 * line (where other users of the host can see it).
 */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  const u = new URL(databaseUrl);
  const vars: Record<string, string> = {};
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host) vars.PGHOST = host;
  if (u.port) vars.PGPORT = u.port;
  if (u.username) vars.PGUSER = decodeURIComponent(u.username);
  if (u.password) vars.PGPASSWORD = decodeURIComponent(u.password);
  for (const [param, name] of Object.entries(LIBPQ_PARAMS)) {
    const v = u.searchParams.get(param);
    if (v !== null) vars[name] = v;
  }
  return vars;
}

/** The database name in the portal's URL. */
export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(name))
    throw new Error('DATABASE_URL names an unexpected database.');
  return name;
}

/** Room the scratch copy may take: the live size plus a margin. */
export function spaceNeeded(databaseBytes: number): number {
  return Math.ceil(databaseBytes * 1.25) + 256 * 1024 * 1024;
}

export interface RestoreTestPreflight {
  databaseBytes: number;
  neededBytes: number;
  /** Free space where the database keeps its files, null when it cannot be measured. */
  freeBytes: number | null;
}

/** Variables a child process may inherit besides the libpq ones. */
const CHILD_ENV_KEEP = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

/** A minimal environment for a child: nothing of the portal's secrets. */
export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_KEEP) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { stdin?: NodeJS.ReadableStream; env?: Record<string, string> },
) => Promise<string>;

/**
 * "Test latest backup": restore the database dump of the newest
 * archive into a scratch database next to the portal's, run a few
 * read-only counts, and drop it. Proves the archive is readable and
 * the dump restores, without touching the portal's own data.
 *
 * Needs room in the database volume for one more copy of the
 * database while it runs, and a database role that may create
 * databases (the default install's role can). The scratch database
 * is dropped on every path, and leftovers from a crash are dropped at
 * the start of the next test.
 */
@Injectable()
export class RestoreTestService {
  private readonly log = new Logger(RestoreTestService.name);
  /** Tests replace this to observe the commands without running them. */
  runner: CommandRunner = runCommand;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly backup: BackupService,
    @Optional() private readonly maintenance?: MaintenanceModeService,
  ) {}

  recent(limit = 10) {
    return this.prisma.backupRestoreTest.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Start a test of the newest archive on disk. Answers with the new
   * row at once; the page polls for the result.
   */
  async start(startedBy: string | null, confirmedBytes: number | null = null) {
    if (this.maintenance?.isActive()) {
      throw new ConflictException(
        'The portal is in maintenance mode. Test a backup after it ends.',
      );
    }
    if (await this.backup.liveRun()) {
      throw new ConflictException('A backup is running. Test after it finishes.');
    }
    await this.prisma.backupRestoreTest.updateMany({
      where: { status: 'running', startedAt: { lt: new Date(Date.now() - STALE_TEST_MS) } },
      data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted before it finished.' },
    });
    if (await this.prisma.backupRestoreTest.findFirst({ where: { status: 'running' } })) {
      throw new ConflictException('A backup test is already running.');
    }
    const runs = await this.backup.listRunsWithArchiveState(50);
    const run = runs.find(
      (r) => r.status === 'succeeded' && r.filename && r.archiveOnDisk !== false,
    );
    if (!run) throw new NotFoundException('There is no finished backup on this server to test.');
    const archive = await this.backup.resolveArchivePath(run.id);
    await this.checkSpace(confirmedBytes);
    // The partial unique index backup_restore_test_one_running_idx lets
    // only one test be "running": a second start at the same moment
    // would otherwise drop the first one's scratch database.
    let row;
    try {
      row = await this.prisma.backupRestoreTest.create({
        data: { runId: run.id, filename: archive.filename, ...(startedBy ? { startedBy } : {}) },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException('A backup test is already running.');
      }
      throw e;
    }
    void this.perform(row.id, archive.path).catch((e: unknown) =>
      this.log.error(`Backup test ${row.id} stopped: ${e instanceof Error ? e.message : e}`),
    );
    return row;
  }

  /** The test itself. Public for tests; `start` is the entry point. */
  async perform(
    testId: string,
    archivePath: string,
  ): Promise<{ ok: boolean; error: string | null }> {
    const dbUrl = this.cfg.get<string>('DATABASE_URL', '');
    const dbName = `${SCRATCH_PREFIX}${randomBytes(8).toString('hex')}`;
    let created = false;
    let error: string | null = null;
    let summary: SanityCounts | null = null;
    try {
      if (!dbUrl) throw new Error('DATABASE_URL is not set.');
      await this.dropLeftovers(dbUrl).catch((e: unknown) =>
        this.log.warn(
          `Could not clear old scratch databases: ${e instanceof Error ? e.message : e}`,
        ),
      );
      const manifestBuf = await readTarEntry(archivePath, 'manifest.json');
      if (!manifestBuf) throw new Error('The archive has no manifest.json.');
      const manifest = JSON.parse(manifestBuf.toString('utf8')) as { databases?: unknown };
      const db =
        Array.isArray(manifest.databases) && typeof manifest.databases[0] === 'string'
          ? manifest.databases[0]
          : 'gratisgis';
      if (!/^[A-Za-z0-9_.-]{1,63}$/.test(db))
        throw new Error('The archive names an unexpected database.');

      const env = pgEnvFromUrl(dbUrl);
      await this.pg('createdb', ['--maintenance-db', 'postgres', dbName], { env });
      created = true;

      // Stream the dump straight from the archive into pg_restore.
      const tar = streamTarEntry(archivePath, `postgres/${db}.dump`);
      try {
        await this.pg(
          'pg_restore',
          ['--no-owner', '--no-privileges', '--exit-on-error', '-d', dbName],
          { stdin: tar.stream, env },
        );
      } catch (e) {
        // tar's own error (a cut-short archive) says more than
        // pg_restore's "unexpected end of file", so give tar a moment
        // to report before stopping it.
        const tarErr = await Promise.race([
          tar.done.then(
            () => null,
            (te: unknown) => te,
          ),
          new Promise((r) => setTimeout(r, 2000).unref()),
        ]);
        tar.kill();
        if (tarErr instanceof Error) throw tarErr;
        throw e;
      }
      await tar.done;

      const counts: Record<string, number> = {};
      for (const [name, sql] of Object.entries(SANITY_QUERIES)) {
        const out = await this.pg(
          'psql',
          ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', dbName, '-c', sql],
          { env },
        );
        const n = Number(out.trim());
        if (!Number.isFinite(n))
          throw new Error(`Could not read the ${name} count from the restored copy.`);
        counts[name] = n;
      }
      summary = counts as unknown as SanityCounts;
      error = judgeSanity(summary);
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).replace(
        /postgres(ql)?:\/\/[^\s'"]+/g,
        '[database url]',
      );
    } finally {
      if (created) {
        await this.pg(
          'dropdb',
          ['--if-exists', '--force', '--maintenance-db', 'postgres', dbName],
          { env: pgEnvFromUrl(dbUrl) },
        ).catch((e: unknown) => {
          const msg = `The scratch database ${dbName} could not be dropped; drop it by hand. ${e instanceof Error ? e.message : ''}`;
          this.log.error(msg.replace(/postgres(ql)?:\/\/[^\s'"]+/g, '[database url]'));
          error = error ? `${error} ${msg}` : msg;
        });
      }
    }
    const ok = error === null;
    await this.prisma.backupRestoreTest.update({
      where: { id: testId },
      data: {
        status: ok ? 'passed' : 'failed',
        finishedAt: new Date(),
        ...(summary ? { summary: summary as unknown as object } : {}),
        error: error ? error.slice(0, 500) : null,
      },
    });
    this.log.log(
      `Backup test ${testId} of ${path.basename(archivePath)}: ${ok ? 'passed' : 'failed'}.`,
    );
    return { ok, error };
  }

  /** Drop scratch databases a crashed test left behind. */
  private async dropLeftovers(dbUrl: string) {
    const env = pgEnvFromUrl(dbUrl);
    const out = await this.pg(
      'psql',
      [
        '-X',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-d',
        'postgres',
        '-c',
        `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_PREFIX}%'`,
      ],
      { env },
    );
    for (const name of out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => SCRATCH_RE.test(l))) {
      await this.pg('dropdb', ['--if-exists', '--force', '--maintenance-db', 'postgres', name], {
        env,
      });
      this.log.warn(`Dropped a scratch database left by an earlier backup test: ${name}`);
    }
  }

  /**
   * How big the portal's database is, how much room a scratch copy
   * needs, and how much is free where the database keeps its files.
   * Free space can be measured when the tools run in the database
   * container (BACKUP_PGDUMP_DOCKER_CONTAINER) or when
   * BACKUP_PG_DATA_DIR names the data directory on this host;
   * otherwise it is null and the admin confirms the size instead.
   */
  async preflight(): Promise<RestoreTestPreflight> {
    const dbUrl = this.cfg.get<string>('DATABASE_URL', '');
    if (!dbUrl) throw new ConflictException('DATABASE_URL is not set.');
    let databaseBytes: number;
    try {
      const out = await this.pg(
        'psql',
        [
          '-X',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-d',
          databaseName(dbUrl),
          '-c',
          'SELECT pg_database_size(current_database())',
        ],
        { env: pgEnvFromUrl(dbUrl) },
      );
      databaseBytes = Number(out.trim());
      if (!Number.isFinite(databaseBytes) || databaseBytes < 0) throw new Error('unreadable size');
    } catch (e) {
      throw new ConflictException(
        `Could not read the size of the database: ${scrub(e instanceof Error ? e.message : String(e))}`,
      );
    }
    return {
      databaseBytes,
      neededBytes: spaceNeeded(databaseBytes),
      freeBytes: await this.freeSpace(),
    };
  }

  private async freeSpace(): Promise<number | null> {
    const container = this.cfg.get<string>('BACKUP_PGDUMP_DOCKER_CONTAINER', '');
    const dataDir = this.cfg.get<string>('BACKUP_PG_DATA_DIR', '');
    try {
      if (container) {
        const out = await this.runner(
          'docker',
          ['exec', container, 'df', '-Pk', dataDir || '/var/lib/postgresql/data'],
          { env: childEnv({}) },
        );
        return parseDfAvailable(out);
      }
      if (dataDir) {
        const st = await fs.statfs(dataDir);
        return Number(st.bavail) * Number(st.bsize);
      }
    } catch (e) {
      this.log.warn(
        `Could not measure free database space: ${scrub(e instanceof Error ? e.message : String(e))}`,
      );
    }
    return null;
  }

  /**
   * Refuse a test that would fill the database volume, or, when free
   * space cannot be measured, one the admin has not confirmed for this
   * size.
   */
  private async checkSpace(confirmedBytes: number | null) {
    const p = await this.preflight();
    if (p.freeBytes !== null) {
      if (p.neededBytes > p.freeBytes) {
        throw new ConflictException(
          `Not enough free space for the test: it needs about ${gb(p.neededBytes)} and the database volume has ${gb(p.freeBytes)} free.`,
        );
      }
      return;
    }
    if (confirmedBytes === null || confirmedBytes < p.databaseBytes) {
      throw new ConflictException({
        message: `Free space in the database volume cannot be measured here. The test makes a second copy of the database, about ${gb(p.databaseBytes)}, while it runs. Confirm there is room for about ${gb(p.neededBytes)}.`,
        needsConfirmation: true,
        databaseBytes: p.databaseBytes,
        neededBytes: p.neededBytes,
      });
    }
  }

  /**
   * Run a PostgreSQL client tool on the host, or inside the database
   * container when BACKUP_PGDUMP_DOCKER_CONTAINER is set (the same
   * switch pg_dump uses). Connection details go in the environment,
   * never in the arguments; in the container, `docker exec -e NAME`
   * passes each one through by name.
   */
  private pg(
    bin: string,
    args: string[],
    opts: { stdin?: NodeJS.ReadableStream; env: Record<string, string> },
  ): Promise<string> {
    const container = this.cfg.get<string>('BACKUP_PGDUMP_DOCKER_CONTAINER', '');
    const env = childEnv(opts.env);
    if (container) {
      const pass = Object.keys(opts.env).flatMap((k) => ['-e', k]);
      return this.runner('docker', ['exec', '-i', ...pass, container, bin, ...args], {
        ...(opts.stdin ? { stdin: opts.stdin } : {}),
        env,
      });
    }
    return this.runner(bin, args, { ...(opts.stdin ? { stdin: opts.stdin } : {}), env });
  }
}

function gb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

function scrub(text: string): string {
  return text.replace(/postgres(ql)?:\/\/[^\s'"]+/g, '[database url]');
}

/** The "Available" column of `df -Pk`, in bytes. */
export function parseDfAvailable(out: string): number | null {
  const line = out.trim().split('\n').at(-1) ?? '';
  const cols = line.trim().split(/\s+/);
  const kb = Number(cols[3]);
  return Number.isFinite(kb) && cols.length >= 4 ? kb * 1024 : null;
}

/**
 * Spawn, feed stdin if given, collect stdout, reject on a non-zero
 * exit. The child gets only the environment it is handed.
 */
function runCommand(
  bin: string,
  args: string[],
  opts: { stdin?: NodeJS.ReadableStream; env?: Record<string, string> } = {},
): Promise<string> {
  const stdin = opts.stdin;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: opts.env ?? childEnv({}),
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout!.on('data', (c: Buffer) => {
      if (out.reduce((n, b) => n + b.length, 0) < 1024 * 1024) out.push(c);
    });
    child.stderr!.on('data', (c: Buffer) => {
      err += c.toString('utf8');
      if (err.length > 16 * 1024) err = err.slice(-8 * 1024);
    });
    if (stdin && child.stdin) {
      stdin.pipe(child.stdin);
      // pg_restore stopping early closes its stdin; that is reported
      // by its exit code, not as an unhandled pipe error.
      child.stdin.on('error', () => undefined);
    }
    child.on('error', (e) => reject(new Error(`Could not run ${bin}: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      const tail = err.trim().split('\n').slice(-3).join(' ');
      reject(new Error(`${bin} failed (exit ${code})${tail ? `: ${tail}` : ''}`));
    });
  });
}
