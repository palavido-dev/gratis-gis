// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/** The scratch database URL: the portal's, with another database name. */
export function scratchUrl(databaseUrl: string, dbName: string): string {
  if (!SCRATCH_RE.test(dbName)) throw new Error('Refusing an unexpected scratch database name.');
  const u = new URL(databaseUrl);
  u.pathname = `/${dbName}`;
  // libpq rejects Prisma's own parameters (schema, connection_limit).
  const keep = new URLSearchParams();
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connect_timeout']) {
    const v = u.searchParams.get(k);
    if (v !== null) keep.set(k, v);
  }
  u.search = keep.toString() ? `?${keep.toString()}` : '';
  return u.toString();
}

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
  runner: (bin: string, args: string[], stdin?: NodeJS.ReadableStream) => Promise<string> =
    runCommand;

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
  async start(startedBy: string | null) {
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
    const row = await this.prisma.backupRestoreTest.create({
      data: { runId: run.id, filename: archive.filename, ...(startedBy ? { startedBy } : {}) },
    });
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

      await this.pg('createdb', ['--maintenance-db', adminUrl(dbUrl), dbName]);
      created = true;

      // Stream the dump straight from the archive into pg_restore.
      const tar = streamTarEntry(archivePath, `postgres/${db}.dump`);
      try {
        await this.pg(
          'pg_restore',
          ['--no-owner', '--no-privileges', '--exit-on-error', '-d', scratchUrl(dbUrl, dbName)],
          tar.stream,
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
        const out = await this.pg('psql', [
          '-X',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-d',
          scratchUrl(dbUrl, dbName),
          '-c',
          sql,
        ]);
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
        await this.pg('dropdb', [
          '--if-exists',
          '--force',
          '--maintenance-db',
          adminUrl(dbUrl),
          dbName,
        ]).catch((e: unknown) => {
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
    const out = await this.pg('psql', [
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      adminUrl(dbUrl),
      '-c',
      `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_PREFIX}%'`,
    ]);
    for (const name of out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => SCRATCH_RE.test(l))) {
      await this.pg('dropdb', [
        '--if-exists',
        '--force',
        '--maintenance-db',
        adminUrl(dbUrl),
        name,
      ]);
      this.log.warn(`Dropped a scratch database left by an earlier backup test: ${name}`);
    }
  }

  /**
   * Run a PostgreSQL client tool on the host, or inside the database
   * container when BACKUP_PGDUMP_DOCKER_CONTAINER is set (the same
   * switch pg_dump uses).
   */
  private pg(bin: string, args: string[], stdin?: NodeJS.ReadableStream): Promise<string> {
    const container = this.cfg.get<string>('BACKUP_PGDUMP_DOCKER_CONTAINER', '');
    if (container) {
      return this.runner('docker', ['exec', '-i', container, bin, ...args], stdin);
    }
    return this.runner(bin, args, stdin);
  }
}

/** The portal's URL pointed at the `postgres` maintenance database. */
export function adminUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.pathname = '/postgres';
  const keep = new URLSearchParams();
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connect_timeout']) {
    const v = u.searchParams.get(k);
    if (v !== null) keep.set(k, v);
  }
  u.search = keep.toString() ? `?${keep.toString()}` : '';
  return u.toString();
}

/** Spawn, feed stdin if given, collect stdout, reject on a non-zero exit. */
function runCommand(bin: string, args: string[], stdin?: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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
