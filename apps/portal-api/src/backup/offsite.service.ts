// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  assertCredentialKeyConfigured,
  decryptCredential,
  encryptCredential,
} from '../items/credential-cipher.js';
import { RunAsSystem } from '../common/tenant-context.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackupFailureNotice } from './backup-failure-notice.js';
import { BackupService } from './backup.service.js';
import {
  missingSettings,
  normalizePrefix,
  OffsiteValidationError,
  redactSecrets,
  resolveOffsiteSettings,
  toPublicConfig,
  validateOffsitePatch,
  type OffsitePatch,
  type OffsitePublicConfig,
  type OffsiteSettings,
} from './offsite-config.js';
import { newSealKey, sealedSize, sealStream, type SealKey } from './offsite-crypto.js';
import {
  archiveArtifacts,
  daysSince,
  OFFSITE_LAYOUT,
  selectExpired,
  staleNoticeKey,
} from './offsite-rules.js';
import {
  createOffsiteClient,
  deleteObject,
  describeS3Error,
  listObjects,
  putSmall,
  uploadStream,
  type S3Like,
} from './offsite-store.js';
import { readTarEntry } from './tar-cli.js';
import { OffsiteMirror } from './offsite-mirror.js';

/** AAD for the two stored secrets; a value cannot move between them. */
const AAD_SECRET = 'backup-offsite:secret-access-key';
const AAD_PASSPHRASE = 'backup-offsite:passphrase';

/** An upload whose beat is older than this belongs to a dead process. */
const STALE_UPLOAD_MS = 5 * 60 * 1000;
const BEAT_EVERY_MS = 10_000;

export type OffsiteMode = 'archive' | 'mirror';

/** What the page shows under the settings. */
export interface OffsiteStatusSummary {
  lastSuccess: {
    runId: string;
    finishedAt: string;
    mode: string | null;
    bytes: string | null;
  } | null;
  lastFailure: { runId: string; finishedAt: string | null; error: string | null } | null;
  running: { runId: string; startedAt: string | null } | null;
  /** Days since the last good off-site copy, null when there is none. */
  daysSinceSuccess: number | null;
  alert: boolean;
}

/**
 * Sends each successful backup to an S3-compatible bucket at another
 * provider, encrypted before it leaves this server.
 *
 * Where each secret lives:
 * - Bucket secret access key: backup_config, AES-256-GCM under
 *   CREDENTIAL_ENCRYPTION_KEY, or BACKUP_OFFSITE_SECRET_ACCESS_KEY(_FILE).
 * - Encryption passphrase: the same, with its own AAD, or
 *   BACKUP_OFFSITE_PASSPHRASE(_FILE). Scheduled runs need it, so it is
 *   kept on this server. It is never written to the bucket, never
 *   returned by the API and never logged. The admin must also keep a
 *   copy somewhere else: if this server is lost, the passphrase in
 *   its database is lost with it, and the off-site copies cannot be
 *   opened without it.
 */
@Injectable()
export class OffsiteService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OffsiteService.name);
  /** Swapped in tests for a fake store. */
  clientFactory: (s: OffsiteSettings) => S3Like = createOffsiteClient;
  /** Scrypt cost; tests lower it. */
  sealCost: number | undefined;
  private readonly mirror: OffsiteMirror;

  constructor(
    private readonly prisma: PrismaService,
    private readonly backup: BackupService,
    @Optional() private readonly notice?: BackupFailureNotice,
    @Optional() private readonly leader?: LeaderElectionService,
  ) {
    this.mirror = new OffsiteMirror(this.log, backup);
  }

  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  onModuleInit() {
    this.backup.onRunSucceeded((info) => this.startUpload(info.runId, info.objectBytes));
  }

  /**
   * Hourly, on the leader: close out uploads a dead process left
   * "running", and raise the "no off-site copy lately" notice when
   * one is due. Both are a couple of indexed reads.
   */
  @RunAsSystem('cron:backup-offsite')
  onApplicationBootstrap() {
    this.sweepTimer = setInterval(
      () => {
        void this.sweep();
      },
      60 * 60 * 1000,
    );
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async sweep(): Promise<void> {
    if (this.leader && !this.leader.shouldRun()) return;
    try {
      const n = await this.reclaimInterrupted();
      if (n > 0) this.log.warn(`Closed out ${n} interrupted off-site upload(s).`);
      await this.checkStale();
    } catch (e) {
      this.log.warn(`Off-site sweep failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------

  /** Effective settings with secrets. Never return this to a client. */
  async settings(): Promise<OffsiteSettings> {
    const row = await this.backup.configRow();
    return resolveOffsiteSettings(
      row,
      {
        secretFromDb: this.tryDecrypt(row.offsiteSecretEncrypted, row.offsiteSecretIv, AAD_SECRET),
        passphraseFromDb: this.tryDecrypt(
          row.offsitePassphraseEncrypted,
          row.offsitePassphraseIv,
          AAD_PASSPHRASE,
        ),
      },
      (name) => process.env[name],
    );
  }

  async getPublicConfig(): Promise<OffsitePublicConfig & { status: OffsiteStatusSummary }> {
    const s = await this.settings();
    return { ...toPublicConfig(s), status: await this.statusSummary(s) };
  }

  async updateConfig(patch: OffsitePatch, updatedBy: string | null) {
    try {
      validateOffsitePatch(patch, { allowHttp: allowHttp() });
    } catch (e) {
      if (e instanceof OffsiteValidationError) throw new BadRequestException(e.message);
      throw e;
    }
    const row = await this.backup.configRow();
    const before = await this.settings();
    const text = (v: string | null): string | null =>
      v === null || v.trim() === '' ? null : v.trim();

    const data: Prisma.BackupConfigUpdateInput = {};
    if (patch.enabled !== undefined) data.offsiteEnabled = patch.enabled;
    if (patch.endpoint !== undefined) data.offsiteEndpoint = text(patch.endpoint);
    if (patch.region !== undefined) data.offsiteRegion = text(patch.region);
    if (patch.bucket !== undefined) data.offsiteBucket = text(patch.bucket);
    if (patch.prefix !== undefined) {
      data.offsitePrefix = patch.prefix === null ? null : normalizePrefix(patch.prefix);
    }
    if (patch.pathStyle !== undefined) data.offsitePathStyle = patch.pathStyle;
    if (patch.accessKeyId !== undefined) data.offsiteAccessKeyId = text(patch.accessKeyId);
    if (patch.retentionDays !== undefined) data.offsiteRetentionDays = patch.retentionDays;
    if (patch.alertDays !== undefined) data.offsiteAlertDays = patch.alertDays;
    if (patch.mirrorThresholdBytes !== undefined) {
      data.offsiteMirrorThresholdBytes =
        patch.mirrorThresholdBytes === null ? null : BigInt(patch.mirrorThresholdBytes);
    }

    // A saved secret only goes with the endpoint and key id it was
    // entered for, as the SMTP password does. Otherwise an admin could
    // point the saved key at a server they run.
    const nextEndpoint =
      patch.endpoint !== undefined ? text(patch.endpoint ?? null) : row.offsiteEndpoint;
    const nextKeyId =
      patch.accessKeyId !== undefined ? text(patch.accessKeyId ?? null) : row.offsiteAccessKeyId;
    const targetChanged =
      (nextEndpoint ?? null) !== (row.offsiteEndpoint ?? null) ||
      (nextKeyId ?? null) !== (row.offsiteAccessKeyId ?? null);
    if (
      targetChanged &&
      row.offsiteSecretEncrypted &&
      (patch.secretAccessKey === undefined || patch.secretAccessKey === null)
    ) {
      throw new BadRequestException(
        'Enter the secret access key again when you change the endpoint or the access key id.',
      );
    }

    const wantsSecretWrite =
      (typeof patch.secretAccessKey === 'string' && patch.secretAccessKey.length > 0) ||
      (typeof patch.passphrase === 'string' && patch.passphrase.length > 0);
    if (wantsSecretWrite) {
      try {
        assertCredentialKeyConfigured();
      } catch {
        throw new BadRequestException(
          'This server has no CREDENTIAL_ENCRYPTION_KEY, so it cannot store secrets. Set the secrets with BACKUP_OFFSITE_* environment variables instead, or ask whoever runs the server to set the key.',
        );
      }
    }
    if (patch.secretAccessKey !== undefined) {
      if (patch.secretAccessKey === null || patch.secretAccessKey === '') {
        data.offsiteSecretEncrypted = null;
        data.offsiteSecretIv = null;
      } else {
        const enc = encryptCredential(patch.secretAccessKey, AAD_SECRET);
        data.offsiteSecretEncrypted = enc.ciphertext;
        data.offsiteSecretIv = enc.iv;
      }
    }
    if (patch.passphrase !== undefined) {
      if (patch.passphrase === null || patch.passphrase === '') {
        data.offsitePassphraseEncrypted = null;
        data.offsitePassphraseIv = null;
      } else {
        const enc = encryptCredential(patch.passphrase, AAD_PASSPHRASE);
        data.offsitePassphraseEncrypted = enc.ciphertext;
        data.offsitePassphraseIv = enc.iv;
      }
    }
    if (updatedBy) data.updatedBy = updatedBy;

    // Turning it on with something missing would only fail every night.
    const turningOn = patch.enabled === true || (patch.enabled === undefined && before.enabled);
    if (turningOn) {
      const preview = await this.previewSettings(row, data);
      const missing = missingSettings(preview);
      if (missing.length > 0) {
        throw new BadRequestException(
          `Fill in these before turning off-site backups on: ${missing.map(fieldLabel).join(', ')}.`,
        );
      }
    }

    await this.prisma.backupConfig.update({ where: { id: row.id }, data });
    const after = await this.settings();
    if (before.passphrase && after.passphrase && before.passphrase !== after.passphrase) {
      this.log.warn(
        'The off-site passphrase was changed. Copies made before this need the old passphrase to open.',
      );
    }
    this.log.log(
      `Off-site backup settings saved (enabled=${after.enabled}, complete=${missingSettings(after).length === 0}).`,
    );
    return this.getPublicConfig();
  }

  /** What settings() would return once `data` is written. */
  private async previewSettings(
    row: Awaited<ReturnType<BackupService['configRow']>>,
    data: Prisma.BackupConfigUpdateInput,
  ): Promise<OffsiteSettings> {
    const merged = { ...row } as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) merged[k] = v;
    const m = merged as typeof row;
    return resolveOffsiteSettings(
      m,
      {
        secretFromDb: this.tryDecrypt(m.offsiteSecretEncrypted, m.offsiteSecretIv, AAD_SECRET),
        passphraseFromDb: this.tryDecrypt(
          m.offsitePassphraseEncrypted,
          m.offsitePassphraseIv,
          AAD_PASSPHRASE,
        ),
      },
      (name) => process.env[name],
    );
  }

  private tryDecrypt(ct: string | null, iv: string | null, aad: string): string | null {
    if (!ct || !iv) return null;
    try {
      return decryptCredential(ct, iv, aad);
    } catch {
      // The value is unusable (key changed or row edited by hand). Say
      // which setting, never the bytes.
      this.log.warn(
        `A stored off-site secret (${aad.split(':')[1]}) could not be decrypted; treating it as not set.`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Test connection
  // ---------------------------------------------------------------

  /**
   * Write, read back and delete one small object under the prefix.
   * Proves the endpoint, keys, bucket, region and clock all work
   * before the first nightly run depends on them.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const s = await this.settings();
    const missing = missingSettings(s).filter((m) => m !== 'passphrase');
    if (missing.length > 0) {
      return { ok: false, message: `Fill in: ${missing.map(fieldLabel).join(', ')}.` };
    }
    const s3 = this.clientFactory(s);
    const key = `${s.prefix}.gratisgis-connection-test-${Date.now().toString(36)}`;
    try {
      await putSmall(s3, s.bucket!, key, Buffer.from('GratisGIS connection test\n'), 'text/plain');
      let found = false;
      for await (const o of listObjects(s3, s.bucket!, key)) if (o.key === key) found = true;
      await deleteObject(s3, s.bucket!, key);
      if (!found) {
        return {
          ok: false,
          message:
            'The test file was written but could not be listed. The key needs permission to list the bucket.',
        };
      }
      return {
        ok: true,
        message: s.passphrase
          ? 'Connected. A test file was written, listed and deleted.'
          : 'Connected. Set an encryption passphrase before turning off-site backups on.',
      };
    } catch (e) {
      const msg = this.safeMessage(e, s);
      this.log.warn(`Off-site connection test failed: ${msg}`);
      return { ok: false, message: msg };
    }
  }

  // ---------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------

  /**
   * Called when a local backup has been published. Resolves once the
   * run is claimed (or skipped) and returns the upload itself as a
   * second promise, so a manual run can answer the browser while the
   * upload carries on and a scheduled run can wait for it.
   */
  async startUpload(runId: string, objectBytes: number | null): Promise<Promise<void> | void> {
    let s: OffsiteSettings;
    try {
      s = await this.settings();
    } catch (e) {
      this.log.warn(`Off-site settings could not be read: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!s.enabled) return;
    const claimed = await this.claim(runId);
    if (!claimed) return;
    return this.upload(runId, s, objectBytes).catch((e: unknown) => {
      // upload() records its own failures; this is a last resort.
      this.log.error(`Off-site upload of ${runId} stopped: ${this.safeMessage(e, s)}`);
    });
  }

  /** Admin "Upload again" for one run. */
  async retry(runId: string): Promise<void> {
    const run = await this.prisma.backupRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Backup run not found');
    if (run.status !== 'succeeded' || !run.filename) {
      throw new ConflictException('Only a finished backup can be copied off-site.');
    }
    const s = await this.settings();
    if (!s.enabled) throw new ConflictException('Off-site backups are turned off.');
    const missing = missingSettings(s);
    if (missing.length > 0) {
      throw new ConflictException(
        `Off-site settings are missing: ${missing.map(fieldLabel).join(', ')}.`,
      );
    }
    if (!(await this.claim(runId))) {
      throw new ConflictException('An off-site upload of this backup is already running.');
    }
    void this.upload(runId, s, null).catch((e: unknown) =>
      this.log.error(`Off-site upload of ${runId} stopped: ${this.safeMessage(e, s)}`),
    );
  }

  /**
   * Mark the run's off-site copy as running, unless a live upload
   * already holds it. Atomic, so two replicas cannot both upload.
   */
  private async claim(runId: string): Promise<boolean> {
    const now = new Date();
    const stale = new Date(now.getTime() - STALE_UPLOAD_MS);
    const res = await this.prisma.backupRun.updateMany({
      where: {
        id: runId,
        status: 'succeeded',
        OR: [
          { offsiteStatus: null },
          { offsiteStatus: { not: 'running' } },
          { offsiteHeartbeatAt: { lt: stale } },
        ],
      },
      data: {
        offsiteStatus: 'running',
        offsiteError: null,
        offsiteStartedAt: now,
        offsiteHeartbeatAt: now,
        offsiteFinishedAt: null,
      },
    });
    return res.count === 1;
  }

  private async upload(
    runId: string,
    s: OffsiteSettings,
    objectBytes: number | null,
  ): Promise<void> {
    const abort = new AbortController();
    let lastBeat = Date.now();
    const beat = async () => {
      if (Date.now() - lastBeat < BEAT_EVERY_MS) return;
      lastBeat = Date.now();
      try {
        await this.prisma.backupRun.update({
          where: { id: runId },
          data: { offsiteHeartbeatAt: new Date() },
          select: { id: true },
        });
      } catch (e) {
        // The run was deleted underneath the upload: stop sending.
        if ((e as { code?: string }).code === 'P2025') abort.abort();
      }
    };
    let mode: OffsiteMode = 'archive';
    try {
      const missing = missingSettings(s);
      if (missing.length > 0) {
        throw new Error(`Off-site settings are missing: ${missing.map(fieldLabel).join(', ')}.`);
      }
      const run = await this.prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
      const dir = run.archiveDirectory ?? (await this.backup.getConfig()).archiveDirectory;
      const archivePath = path.join(dir, run.filename!);
      const size = (await fs.stat(archivePath)).size;
      const bytesOfObjects = objectBytes ?? (await this.objectBytesFromManifest(archivePath));
      mode =
        this.mirror.available && bytesOfObjects !== null && bytesOfObjects > s.mirrorThresholdBytes
          ? 'mirror'
          : 'archive';
      await this.prisma.backupRun.update({ where: { id: runId }, data: { offsiteMode: mode } });

      const s3 = this.clientFactory(s);
      const key = await newSealKey(s.passphrase!, this.sealCost ? { logN: this.sealCost } : {});
      const result =
        mode === 'mirror'
          ? await this.mirror.upload({ s3, s, key, run, archivePath, signal: abort.signal, beat })
          : await this.uploadArchive({
              s3,
              s,
              key,
              run,
              archivePath,
              size,
              signal: abort.signal,
              beat,
            });

      await this.prisma.backupRun.update({
        where: { id: runId },
        data: {
          offsiteStatus: 'succeeded',
          offsiteKey: result.key,
          offsiteBytes: BigInt(result.bytes),
          offsiteSha256: result.sha256,
          offsiteFinishedAt: new Date(),
          offsiteError: null,
        },
      });
      this.log.log(`Off-site copy of backup ${runId} uploaded (${mode}, ${result.bytes} bytes).`);
      try {
        await this.enforceRetention(s, s3);
      } catch (e) {
        this.log.warn(`Off-site retention failed: ${this.safeMessage(e, s)}`);
      }
    } catch (e) {
      const msg = abort.signal.aborted
        ? 'Stopped: the backup was deleted while its off-site copy was uploading.'
        : this.safeMessage(e, s);
      this.log.error(`Off-site copy of backup ${runId} failed: ${msg}`);
      await this.prisma.backupRun
        .update({
          where: { id: runId },
          data: {
            offsiteStatus: 'failed',
            offsiteMode: mode,
            offsiteError: msg.slice(0, 500),
            offsiteFinishedAt: new Date(),
          },
        })
        .catch(() => undefined);
      await this.notice?.announceOffsite(`failed:${runId}`, { runId, kind: 'offsite_failed' });
    }
    await this.checkStale().catch((e: unknown) =>
      this.log.warn(`Off-site staleness check failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  private async uploadArchive(a: {
    s3: S3Like;
    s: OffsiteSettings;
    key: SealKey;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    size: number;
    signal: AbortSignal;
    beat: () => Promise<void>;
  }): Promise<{ key: string; bytes: number; sha256: string }> {
    const name = `${a.run.filename}${OFFSITE_LAYOUT.sealed}`;
    const objectKey = `${a.s.prefix}${OFFSITE_LAYOUT.archives}${name}`;
    const expected = sealedSize(a.size);
    const up = await uploadStream(a.s3, {
      bucket: a.s.bucket!,
      key: objectKey,
      body: sealStream(readLazily(a.archivePath), a.key),
      expectedBytes: expected,
      signal: a.signal,
      onPart: a.beat,
    });
    // Written last: its presence is what marks the copy complete.
    const sidecar = {
      format: 'GRCV2',
      kind: 'archive',
      runId: a.run.id,
      archive: a.run.filename,
      createdAt: a.run.startedAt.toISOString(),
      plainBytes: a.size,
      sealedBytes: up.bytes,
      sealedSha256: up.sha256,
    };
    await putSmall(
      a.s3,
      a.s.bucket!,
      `${objectKey}.json`,
      Buffer.from(JSON.stringify(sidecar, null, 2)),
    );
    return { key: objectKey, bytes: up.bytes, sha256: up.sha256 };
  }

  private async objectBytesFromManifest(archivePath: string): Promise<number | null> {
    try {
      const buf = await readTarEntry(archivePath, 'manifest.json');
      if (!buf) return null;
      const m = JSON.parse(buf.toString('utf8')) as { minio?: { totalBytes?: unknown } };
      return typeof m.minio?.totalBytes === 'number' ? m.minio.totalBytes : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------

  /**
   * Delete off-site copies older than the retention window, never the
   * newest complete one. Only names this feature writes are touched.
   * Bucket versioning or object lock at the provider is what protects
   * history from a compromised server; see the help page.
   */
  async enforceRetention(s: OffsiteSettings, s3: S3Like = this.clientFactory(s)): Promise<number> {
    const now = new Date();
    const archivesPrefix = `${s.prefix}${OFFSITE_LAYOUT.archives}`;
    const listing = [];
    for await (const o of listObjects(s3, s.bucket!, archivesPrefix)) listing.push(o);
    const artifacts = archiveArtifacts(listing, archivesPrefix);
    let removed = 0;
    for (const id of selectExpired(artifacts, now, s.retentionDays)) {
      const a = artifacts.find((x) => x.id === id)!;
      // Sidecar first, so a half-deleted copy never reads as complete.
      const ordered = [...a.keys].sort(
        (x, y) => Number(y.endsWith('.json')) - Number(x.endsWith('.json')),
      );
      for (const k of ordered) {
        await deleteObject(s3, s.bucket!, k);
        removed += 1;
      }
    }
    removed += await this.mirror.enforceRetention(s, s3, now);
    if (removed > 0) this.log.log(`Off-site retention removed ${removed} object(s).`);
    return removed;
  }

  // ---------------------------------------------------------------
  // Health and notices
  // ---------------------------------------------------------------

  private async lastSuccess() {
    return this.prisma.backupRun.findFirst({
      where: { offsiteStatus: 'succeeded' },
      orderBy: { offsiteFinishedAt: 'desc' },
      select: { id: true, offsiteFinishedAt: true, offsiteMode: true, offsiteBytes: true },
    });
  }

  /** Raise the "no off-site copy lately" notice when one is due. */
  async checkStale(now = new Date()): Promise<string | null> {
    const s = await this.settings();
    const last = await this.lastSuccess();
    const first = await this.prisma.backupRun.findFirst({
      where: { offsiteStatus: { not: null } },
      orderBy: { offsiteStartedAt: 'asc' },
      select: { offsiteStartedAt: true },
    });
    const key = staleNoticeKey({
      enabled: s.enabled,
      alertDays: s.alertDays,
      now,
      lastSuccess: last?.offsiteFinishedAt ? { runId: last.id, at: last.offsiteFinishedAt } : null,
      firstAttemptAt: first?.offsiteStartedAt ?? null,
    });
    if (!key) return null;
    await this.notice?.announceOffsite(key, {
      kind: 'offsite_stale',
      days: daysSince(last?.offsiteFinishedAt ?? null, now),
    });
    return key;
  }

  async statusSummary(s?: OffsiteSettings): Promise<OffsiteStatusSummary> {
    const settings = s ?? (await this.settings());
    const now = new Date();
    const last = await this.lastSuccess();
    const failed = await this.prisma.backupRun.findFirst({
      where: { offsiteStatus: 'failed' },
      orderBy: { offsiteFinishedAt: 'desc' },
      select: { id: true, offsiteFinishedAt: true, offsiteError: true },
    });
    const running = await this.prisma.backupRun.findFirst({
      where: { offsiteStatus: 'running' },
      orderBy: { offsiteStartedAt: 'desc' },
      select: { id: true, offsiteStartedAt: true },
    });
    const days = daysSince(last?.offsiteFinishedAt ?? null, now);
    return {
      lastSuccess: last?.offsiteFinishedAt
        ? {
            runId: last.id,
            finishedAt: last.offsiteFinishedAt.toISOString(),
            mode: last.offsiteMode,
            bytes: last.offsiteBytes === null ? null : last.offsiteBytes.toString(),
          }
        : null,
      lastFailure: failed
        ? {
            runId: failed.id,
            finishedAt: failed.offsiteFinishedAt?.toISOString() ?? null,
            error: failed.offsiteError,
          }
        : null,
      running: running
        ? { runId: running.id, startedAt: running.offsiteStartedAt?.toISOString() ?? null }
        : null,
      daysSinceSuccess: days,
      alert: settings.enabled && (days === null ? failed !== null : days > settings.alertDays),
    };
  }

  /**
   * Close out uploads whose process died (deploy, crash). Same idea
   * as the dead-run reclaim of local backups.
   */
  async reclaimInterrupted(): Promise<number> {
    const stale = new Date(Date.now() - STALE_UPLOAD_MS);
    const res = await this.prisma.backupRun.updateMany({
      where: {
        offsiteStatus: 'running',
        OR: [{ offsiteHeartbeatAt: { lt: stale } }, { offsiteHeartbeatAt: null }],
      },
      data: {
        offsiteStatus: 'failed',
        offsiteFinishedAt: new Date(),
        offsiteError:
          'Interrupted: the process uploading this copy stopped (a deploy, restart or crash). Use "Upload again" to retry.',
      },
    });
    return res.count;
  }

  /** An error message with every secret removed, for logs and rows. */
  private safeMessage(e: unknown, s: OffsiteSettings): string {
    return redactSecrets(describeS3Error(e), [s.secretAccessKey, s.passphrase]);
  }
}

/**
 * The file's bytes, opened only when first read. A stream opened up
 * front would be left dangling (and raise an unhandled error) when the
 * upload fails before it reads anything.
 */
async function* readLazily(file: string): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(file)) yield chunk as Buffer;
}

export function allowHttp(): boolean {
  return (process.env.BACKUP_OFFSITE_ALLOW_HTTP ?? '').toLowerCase() === 'true';
}

function fieldLabel(f: string): string {
  switch (f) {
    case 'endpoint':
      return 'endpoint';
    case 'bucket':
      return 'bucket';
    case 'accessKeyId':
      return 'access key id';
    case 'secretAccessKey':
      return 'secret access key';
    case 'passphrase':
      return 'encryption passphrase';
    default:
      return f;
  }
}
