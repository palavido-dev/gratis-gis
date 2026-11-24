// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  type OffsiteRow,
  type OffsiteSettings,
} from './offsite-config.js';
import {
  looksLikePrivateKey,
  OffsiteCryptoError,
  OFFSITE_FORMAT,
  parseFingerprint,
  parsePublicKey,
  sealedSize,
  sealStream,
  type OffsitePublicKey,
} from './offsite-crypto.js';
import { assertEndpointReachable, endpointPolicy, type EndpointPolicy } from './offsite-endpoint.js';
import { OffsiteMirror, PrismaMirrorIndex, type MirrorIndexStore } from './offsite-mirror.js';
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
  getSmall,
  listObjects,
  putSmall,
  uploadStream,
  type S3Like,
} from './offsite-store.js';
import { readTarEntry } from './tar-cli.js';

/** AAD prefixes for the stored secrets; a value cannot move between them. */
const AAD_SECRET = 'backup-offsite:secret-access-key';
const AAD_NAME_KEY = 'backup-offsite:mirror-name-key';

/** An upload whose beat is older than this belongs to a dead process. */
const STALE_UPLOAD_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type OffsiteMode = 'archive' | 'mirror';

/** What the run-succeeded hook gets back: the upload, still running. */
export interface UploadHandle {
  done: Promise<void>;
}

/** What the page shows under the settings. */
export interface OffsiteStatusSummary {
  lastSuccess: {
    runId: string;
    finishedAt: string;
    mode: string | null;
    bytes: string | null;
    keyFingerprint: string | null;
  } | null;
  lastFailure: { runId: string; finishedAt: string | null; error: string | null } | null;
  running: { runId: string; startedAt: string | null } | null;
  /** Days since the last good off-site copy, null when there is none. */
  daysSinceSuccess: number | null;
  alert: boolean;
}

/**
 * The stored secret only opens for the endpoint and access key id it
 * was saved with, so a changed endpoint cannot take it along.
 */
function secretAad(endpoint: string | null, keyId: string | null): string {
  const bind = createHash('sha256')
    .update(`${endpoint ?? ''}\n${keyId ?? ''}`)
    .digest('hex');
  return `${AAD_SECRET}:${bind}`;
}

/**
 * Sends each successful backup to an S3-compatible bucket at another
 * provider, encrypted before it leaves this server.
 *
 * Files are encrypted to the admin's public key (offsite-crypto.ts).
 * This server holds only that public key: it can make off-site copies
 * but cannot read any of them, and it never accepts, stores, logs or
 * returns a private key or its passphrase.
 *
 * What it does hold:
 * - The bucket secret access key: backup_config, AES-256-GCM under
 *   CREDENTIAL_ENCRYPTION_KEY with the endpoint and key id bound in,
 *   or BACKUP_OFFSITE_SECRET_ACCESS_KEY(_FILE).
 * - The mirror naming key (random, made once): same cipher.
 * - The local index of mirrored files (backup_offsite_object).
 */
@Injectable()
export class OffsiteService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OffsiteService.name);
  /** Swapped in tests for a fake store. */
  clientFactory: (s: OffsiteSettings) => S3Like = createOffsiteClient;
  /** Swapped in tests: DNS check before connecting. */
  endpointCheck: (endpoint: string, policy: EndpointPolicy) => Promise<void> =
    assertEndpointReachable;
  /** How often a running upload writes its heartbeat. */
  beatEveryMs = 10_000;
  private readonly mirror: OffsiteMirror;
  private readonly index: MirrorIndexStore;

  constructor(
    private readonly prisma: PrismaService,
    private readonly backup: BackupService,
    @Optional() private readonly notice?: BackupFailureNotice,
    @Optional() private readonly leader?: LeaderElectionService,
  ) {
    this.mirror = new OffsiteMirror(this.log, backup);
    this.index = new PrismaMirrorIndex(prisma as never);
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

  private policy(): EndpointPolicy {
    return endpointPolicy();
  }

  private env = (name: string) => process.env[name];

  /** Settings for a row, with the stored secret opened if it still fits. */
  private resolve(row: OffsiteRow & { offsiteSecretEncrypted: string | null; offsiteSecretIv: string | null }) {
    const policy = this.policy();
    // The endpoint and key id first: the secret is bound to them.
    const plain = resolveOffsiteSettings(row, { secretFromDb: null }, this.env, policy);
    const secretFromDb = this.tryDecrypt(
      row.offsiteSecretEncrypted,
      row.offsiteSecretIv,
      secretAad(plain.endpoint, plain.accessKeyId),
      'secret access key',
    );
    return resolveOffsiteSettings(row, { secretFromDb }, this.env, policy);
  }

  /** Effective settings with the secret. Never return this to a client. */
  async settings(): Promise<OffsiteSettings> {
    return this.resolve(await this.ensureInstallId());
  }

  /**
   * The random id that marks this portal's folder in the bucket, made
   * once. Two portals pointed at one folder are stopped before either
   * cleans up the other's copies.
   */
  private async ensureInstallId() {
    const row = await this.backup.configRow();
    if (row.offsiteInstallId) return row;
    await this.prisma.backupConfig.updateMany({
      where: { id: row.id, offsiteInstallId: null },
      data: { offsiteInstallId: randomUUID() },
    });
    return this.backup.configRow();
  }

  async getPublicConfig(): Promise<OffsitePublicConfig & { status: OffsiteStatusSummary }> {
    const s = await this.settings();
    return { ...toPublicConfig(s, this.policy()), status: await this.statusSummary(s) };
  }

  async updateConfig(patch: OffsitePatch, updatedBy: string | null) {
    try {
      validateOffsitePatch(patch, this.policy());
    } catch (e) {
      if (e instanceof OffsiteValidationError) throw new BadRequestException(e.message);
      throw e;
    }
    const row = await this.ensureInstallId();
    const before = this.resolve(row);
    const text = (v: string | null): string | null =>
      v === null || v.trim() === '' ? null : v.trim();

    const data: Prisma.BackupConfigUpdateInput = {};
    if (patch.enabled !== undefined) data.offsiteEnabled = patch.enabled;
    if (patch.endpoint !== undefined) {
      const e = text(patch.endpoint);
      data.offsiteEndpoint = e === null ? null : e.replace(/\/+$/, '');
    }
    if (patch.region !== undefined) data.offsiteRegion = text(patch.region);
    if (patch.bucket !== undefined) data.offsiteBucket = text(patch.bucket);
    if (patch.prefix !== undefined) {
      data.offsitePrefix = patch.prefix === null ? null : normalizePrefix(patch.prefix);
    }
    if (patch.pathStyle !== undefined) data.offsitePathStyle = patch.pathStyle;
    if (patch.accessKeyId !== undefined) data.offsiteAccessKeyId = text(patch.accessKeyId);
    if (patch.publicKey !== undefined) {
      const pk = text(patch.publicKey);
      data.offsitePublicKey = pk === null ? null : parsePublicKey(pk).text;
    }
    if (patch.retentionDays !== undefined) data.offsiteRetentionDays = patch.retentionDays;
    if (patch.alertDays !== undefined) data.offsiteAlertDays = patch.alertDays;
    if (patch.mirrorThresholdBytes !== undefined) {
      data.offsiteMirrorThresholdBytes =
        patch.mirrorThresholdBytes === null ? null : BigInt(patch.mirrorThresholdBytes);
    }

    // Where the bucket secret would be sent after this save. Whatever
    // its source (saved here or set in the environment), the secret
    // only goes with the endpoint and key id it was entered for, as
    // the SMTP password does: a new endpoint or key id needs it typed
    // again. Clearing the saved secret does not count as typing one.
    const merged = { ...row } as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) merged[k] = v;
    const next = merged as typeof row;
    const policy = this.policy();
    const after = resolveOffsiteSettings(next, { secretFromDb: null }, this.env, policy);
    const typedSecret =
      typeof patch.secretAccessKey === 'string' && patch.secretAccessKey.length > 0;
    const clearing = patch.secretAccessKey !== undefined && !typedSecret;
    const targetChanged =
      (after.endpoint ?? null) !== (before.endpoint ?? null) ||
      (after.accessKeyId ?? null) !== (before.accessKeyId ?? null);
    const hadSecret = before.secretAccessKey !== null || after.secretAccessKey !== null;
    if (targetChanged && hadSecret && !typedSecret) {
      throw new BadRequestException(
        'Enter the secret access key again when you change the endpoint or the access key id.',
      );
    }

    if (typedSecret) {
      try {
        assertCredentialKeyConfigured();
      } catch {
        throw new BadRequestException(
          'This server has no CREDENTIAL_ENCRYPTION_KEY, so it cannot store secrets. Set the secret with BACKUP_OFFSITE_SECRET_ACCESS_KEY instead, or ask whoever runs the server to set the key.',
        );
      }
      const enc = encryptCredential(
        patch.secretAccessKey as string,
        secretAad(after.endpoint, after.accessKeyId),
      );
      data.offsiteSecretEncrypted = enc.ciphertext;
      data.offsiteSecretIv = enc.iv;
    } else if (clearing) {
      data.offsiteSecretEncrypted = null;
      data.offsiteSecretIv = null;
    }
    if (updatedBy) data.updatedBy = updatedBy;

    // Turning it on with something missing would only fail every night.
    const turningOn = patch.enabled === true || (patch.enabled === undefined && before.enabled);
    if (turningOn) {
      const dbSecret = typedSecret
        ? (patch.secretAccessKey as string)
        : clearing || before.secretSource !== 'database'
          ? null
          : before.secretAccessKey;
      const preview = resolveOffsiteSettings(next, { secretFromDb: dbSecret }, this.env, policy);
      const missing = missingSettings(preview);
      if (missing.length > 0) {
        throw new BadRequestException(
          `Fill in these before turning off-site backups on: ${missing.map(fieldLabel).join(', ')}.`,
        );
      }
      if (preview.problems.length > 0) {
        throw new BadRequestException(
          `Fix these before turning off-site backups on: ${preview.problems.join(' ')}`,
        );
      }
    }

    await this.prisma.backupConfig.update({ where: { id: row.id }, data });
    const saved = await this.settings();
    if (
      before.publicKey &&
      saved.publicKey &&
      before.publicKey.fingerprintText !== saved.publicKey.fingerprintText
    ) {
      this.log.warn(
        `The off-site public key was replaced (fingerprint ${before.publicKey.fingerprintText} is now ${saved.publicKey.fingerprintText}). New copies use the new key; older copies still open only with the old private key.`,
      );
    }
    this.log.log(
      `Off-site backup settings saved (enabled=${saved.enabled}, complete=${missingSettings(saved).length === 0}${saved.publicKey ? `, key ${saved.publicKey.fingerprintText}` : ''}).`,
    );
    return this.getPublicConfig();
  }

  private tryDecrypt(
    ct: string | null,
    iv: string | null,
    aad: string,
    what: string,
  ): string | null {
    if (!ct || !iv) return null;
    try {
      return decryptCredential(ct, iv, aad);
    } catch {
      // Unusable: the endpoint or key id changed outside this page, the
      // server key changed, or the row was edited by hand. Say which
      // setting, never the bytes.
      this.log.warn(
        `The stored off-site ${what} could not be opened (it is bound to the endpoint and key id it was saved with); treating it as not set.`,
      );
      return null;
    }
  }

  /**
   * "Check my key": does what the admin pastes (a public key or its
   * fingerprint) match the key this server encrypts to? Never takes a
   * private key or passphrase, and never logs what was pasted.
   */
  async checkKey(value: string): Promise<{
    matches: boolean;
    serverFingerprint: string | null;
    checkedFingerprint: string;
  }> {
    if (looksLikePrivateKey(value)) {
      throw new BadRequestException(
        'That is a private key. Never paste it into the portal. Paste the public key or its fingerprint.',
      );
    }
    let fp: Buffer | null = parseFingerprint(value);
    if (!fp) {
      try {
        fp = parsePublicKey(value).fingerprint;
      } catch (e) {
        throw new BadRequestException(
          e instanceof OffsiteCryptoError
            ? e.message
            : 'Paste a public key (ggpub1:...) or a fingerprint (32 hex digits).',
        );
      }
    }
    const s = await this.settings();
    const server = s.publicKey?.fingerprint ?? null;
    return {
      matches: server !== null && server.equals(fp),
      serverFingerprint: s.publicKey?.fingerprintText ?? null,
      checkedFingerprint: (fp.toString('hex').match(/.{4}/g) ?? []).join('-'),
    };
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
    const missing = missingSettings(s).filter((m) => m !== 'publicKey');
    if (missing.length > 0 || s.problems.length > 0) {
      return {
        ok: false,
        message: [
          missing.length ? `Fill in: ${missing.map(fieldLabel).join(', ')}.` : '',
          ...s.problems,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    try {
      await this.endpointCheck(s.endpoint!, this.policy());
      const s3 = this.clientFactory(s);
      const owner = await this.readInstallMarker(s3, s);
      if (owner && owner !== s.installId) {
        return { ok: false, message: foreignFolderMessage(owner) };
      }
      const key = `${s.prefix}.gratisgis-connection-test-${Date.now().toString(36)}`;
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
        message: s.publicKey
          ? 'Connected. A test file was written, listed and deleted.'
          : 'Connected. Add your public key before turning off-site backups on.',
      };
    } catch (e) {
      const msg = this.safeMessage(e, s);
      this.log.warn(`Off-site connection test failed: ${msg}`);
      return { ok: false, message: msg };
    }
  }

  // ---------------------------------------------------------------
  // Folder ownership
  // ---------------------------------------------------------------

  private markerKey(s: OffsiteSettings) {
    return `${s.prefix}${OFFSITE_LAYOUT.installMarker}`;
  }

  /** The install id written under the prefix, or null when there is none. */
  private async readInstallMarker(s3: S3Like, s: OffsiteSettings): Promise<string | null> {
    let buf: Buffer;
    try {
      buf = await getSmall(s3, s.bucket!, this.markerKey(s));
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
    try {
      const j = JSON.parse(buf.toString('utf8')) as { installId?: unknown };
      return typeof j.installId === 'string' ? j.installId : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Claim the folder for this portal, or stop when another one has it. */
  private async ensureInstallMarker(s3: S3Like, s: OffsiteSettings): Promise<void> {
    if (!s.installId) throw new Error('This portal has no install id yet.');
    const owner = await this.readInstallMarker(s3, s);
    if (owner === s.installId) return;
    if (owner !== null) throw new Error(foreignFolderMessage(owner));
    await putSmall(
      s3,
      s.bucket!,
      this.markerKey(s),
      Buffer.from(
        JSON.stringify(
          { kind: 'gratisgis-offsite-folder', installId: s.installId, createdAt: new Date().toISOString() },
          null,
          2,
        ),
      ),
    );
  }

  // ---------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------

  /**
   * Called when a local backup has been published. Resolves as soon
   * as the run is claimed (or skipped), with the upload still running
   * in `done`. A scheduled run waits for `done`; a manual run answers
   * the browser without it. Never a bare promise: an async function
   * returning one would be flattened into a single wait.
   */
  async startUpload(runId: string, objectBytes: number | null): Promise<UploadHandle | undefined> {
    let s: OffsiteSettings;
    try {
      s = await this.settings();
    } catch (e) {
      this.log.warn(`Off-site settings could not be read: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
    if (!s.enabled) return undefined;
    if (!(await this.claim(runId))) {
      this.log.warn(`Off-site copy of backup ${runId} not started: another off-site upload is running.`);
      return undefined;
    }
    const done = this.upload(runId, s, objectBytes).catch((e: unknown) => {
      // upload() records its own failures; this is a last resort.
      this.log.error(`Off-site upload of ${runId} stopped: ${this.safeMessage(e, s)}`);
    });
    return { done };
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
    // Retention would delete an older copy again straight away.
    if (run.startedAt.getTime() < Date.now() - s.retentionDays * DAY_MS) {
      throw new ConflictException(
        'This backup is older than the off-site retention window, so its copy would be deleted again at once.',
      );
    }
    // A mirror copy always holds the files as they are now, so an older
    // dump would be paired with newer files.
    const mode = await this.chooseMode(s, run, null);
    if (mode === 'mirror') {
      const newest = await this.prisma.backupRun.findFirst({
        where: { status: 'succeeded' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      if (newest && newest.id !== run.id) {
        throw new ConflictException(
          'Large stores are copied file by file as they are now, so only the newest backup can be uploaded again.',
        );
      }
    }
    if (!(await this.claim(runId))) {
      throw new ConflictException(
        'An off-site upload is already running. Try again when it finishes.',
      );
    }
    void this.upload(runId, s, null).catch((e: unknown) =>
      this.log.error(`Off-site upload of ${runId} stopped: ${this.safeMessage(e, s)}`),
    );
  }

  /**
   * Mark the run's off-site copy as running. One upload at a time for
   * the whole install: the partial unique index on offsite_status
   * refuses a second "running" row, so two replicas or two triggers
   * cannot upload (or clean up) at once. A dead upload is closed out
   * first.
   */
  private async claim(runId: string): Promise<boolean> {
    await this.reclaimInterrupted();
    const now = new Date();
    try {
      const res = await this.prisma.backupRun.updateMany({
        where: {
          id: runId,
          status: 'succeeded',
          OR: [{ offsiteStatus: null }, { offsiteStatus: { not: 'running' } }],
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
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
  }

  private async chooseMode(
    s: OffsiteSettings,
    run: { archiveDirectory: string | null; filename: string | null },
    objectBytes: number | null,
  ): Promise<OffsiteMode> {
    const dir = run.archiveDirectory ?? (await this.backup.getConfig()).archiveDirectory;
    const bytes = objectBytes ?? (await this.objectBytesFromManifest(path.join(dir, run.filename!)));
    return bytes !== null && bytes > s.mirrorThresholdBytes ? 'mirror' : 'archive';
  }

  private async upload(
    runId: string,
    s: OffsiteSettings,
    objectBytes: number | null,
  ): Promise<void> {
    const abort = new AbortController();
    // A timer, not calls in each loop: the beat must keep coming while
    // one long step (a big part, a slow listing) is in progress.
    const timer = setInterval(() => {
      this.prisma.backupRun
        .update({
          where: { id: runId },
          data: { offsiteHeartbeatAt: new Date() },
          select: { id: true },
        })
        .catch((e: unknown) => {
          // The run was deleted underneath the upload: stop sending.
          if ((e as { code?: string }).code === 'P2025') abort.abort();
        });
    }, this.beatEveryMs);
    timer.unref?.();
    let mode: OffsiteMode = 'archive';
    try {
      const missing = missingSettings(s);
      if (missing.length > 0) {
        throw new Error(`Off-site settings are missing: ${missing.map(fieldLabel).join(', ')}.`);
      }
      if (s.problems.length > 0) throw new Error(s.problems.join(' '));
      const policy = this.policy();
      await this.endpointCheck(s.endpoint!, policy);
      if (s.endpoint!.startsWith('http:')) {
        this.log.warn(
          'The off-site endpoint uses plain http (allowed by BACKUP_OFFSITE_ALLOW_HTTP). The files are encrypted, but the bucket keys and names travel unprotected.',
        );
      }
      const run = await this.prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
      const dir = run.archiveDirectory ?? (await this.backup.getConfig()).archiveDirectory;
      const archivePath = path.join(dir, run.filename!);
      const size = (await fs.stat(archivePath)).size;
      mode = await this.chooseMode(s, run, objectBytes);
      await this.prisma.backupRun.update({
        where: { id: runId },
        data: { offsiteMode: mode, offsiteKeyFingerprint: s.publicKey!.fingerprintText },
      });

      const s3 = this.clientFactory(s);
      await this.ensureInstallMarker(s3, s);
      const result =
        mode === 'mirror'
          ? await this.mirror.upload({
              s3,
              s,
              publicKey: s.publicKey!,
              nameKey: await this.nameKey(),
              index: this.index,
              run,
              archivePath,
              signal: abort.signal,
            })
          : await this.uploadArchive({
              s3,
              s,
              publicKey: s.publicKey!,
              run,
              archivePath,
              size,
              signal: abort.signal,
            });

      // Clean up while this upload still holds the install-wide claim,
      // so no other upload can be using what is removed.
      try {
        await this.enforceRetention(s, s3, runId);
      } catch (e) {
        this.log.warn(`Off-site retention failed: ${this.safeMessage(e, s)}`);
      }
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
      this.log.log(
        `Off-site copy of backup ${runId} uploaded (${mode}, ${result.bytes} bytes, key ${s.publicKey!.fingerprintText}).`,
      );
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
    } finally {
      clearInterval(timer);
    }
    await this.checkStale().catch((e: unknown) =>
      this.log.warn(`Off-site staleness check failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  /**
   * The key that names mirrored files, made once and stored with the
   * credential cipher. Mirror mode needs CREDENTIAL_ENCRYPTION_KEY.
   */
  private async nameKey(): Promise<Buffer> {
    try {
      assertCredentialKeyConfigured();
    } catch {
      throw new Error(
        'Copying a large store file by file needs CREDENTIAL_ENCRYPTION_KEY on this server.',
      );
    }
    const read = async () => {
      const row = await this.backup.configRow();
      if (!row.offsiteNameKeyEncrypted || !row.offsiteNameKeyIv) return null;
      try {
        return Buffer.from(
          decryptCredential(row.offsiteNameKeyEncrypted, row.offsiteNameKeyIv, AAD_NAME_KEY),
          'base64',
        );
      } catch {
        return undefined;
      }
    };
    const have = await read();
    if (have) return have;
    const enc = encryptCredential(randomBytes(32).toString('base64'), AAD_NAME_KEY);
    const row = await this.backup.configRow();
    if (have === undefined) {
      // The stored key no longer opens (the server key changed). Files
      // get new names and are uploaded again; old ones age out.
      this.log.warn('The off-site naming key could not be opened; making a new one.');
      await this.prisma.backupConfig.update({
        where: { id: row.id },
        data: { offsiteNameKeyEncrypted: enc.ciphertext, offsiteNameKeyIv: enc.iv },
      });
    } else {
      await this.prisma.backupConfig.updateMany({
        where: { id: row.id, offsiteNameKeyEncrypted: null },
        data: { offsiteNameKeyEncrypted: enc.ciphertext, offsiteNameKeyIv: enc.iv },
      });
    }
    const made = await read();
    if (!made) throw new Error('The off-site naming key could not be stored.');
    return made;
  }

  private async uploadArchive(a: {
    s3: S3Like;
    s: OffsiteSettings;
    publicKey: OffsitePublicKey;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    size: number;
    signal: AbortSignal;
  }): Promise<{ key: string; bytes: number; sha256: string }> {
    const name = `${a.run.filename}${OFFSITE_LAYOUT.sealed}`;
    const objectKey = `${a.s.prefix}${OFFSITE_LAYOUT.archives}${name}`;
    const up = await uploadStream(a.s3, {
      bucket: a.s.bucket!,
      key: objectKey,
      body: sealStream(readLazily(a.archivePath), a.publicKey),
      expectedBytes: sealedSize(a.size),
      signal: a.signal,
    });
    // Written last: its presence is what marks the copy complete.
    const sidecar = {
      format: OFFSITE_FORMAT,
      kind: 'archive',
      runId: a.run.id,
      installId: a.s.installId,
      keyFingerprint: a.publicKey.fingerprintText,
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

  /** Another upload than `self` holds the claim and is alive. */
  private async otherUploadRunning(self: string | null): Promise<boolean> {
    const other = await this.prisma.backupRun.findFirst({
      where: {
        offsiteStatus: 'running',
        ...(self ? { id: { not: self } } : {}),
      },
      select: { id: true },
    });
    return other !== null;
  }

  /**
   * Delete off-site copies older than the retention window, never the
   * newest complete one. Only names this feature writes, under this
   * portal's own folder, are touched. Mirror files are collected only
   * when no other upload is running. Bucket versioning or object lock
   * at the provider is what protects history from a compromised
   * server; see the help page.
   */
  async enforceRetention(
    s: OffsiteSettings,
    s3: S3Like = this.clientFactory(s),
    self: string | null = null,
  ): Promise<number> {
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
    const collect = !(await this.otherUploadRunning(self));
    if (!collect) this.log.log('Another off-site upload is running; mirror files are not collected this time.');
    const m = await this.mirror.enforceRetention(s, s3, now, this.index, collect);
    removed += m.removed;
    if (m.unknownKept > 0) {
      this.log.log(
        `${m.unknownKept} mirrored file(s) in the bucket are not in this server's index and were kept. A bucket lifecycle rule can remove them once they are older than your retention window.`,
      );
    }
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
      select: {
        id: true,
        offsiteFinishedAt: true,
        offsiteMode: true,
        offsiteBytes: true,
        offsiteKeyFingerprint: true,
      },
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
            keyFingerprint: last.offsiteKeyFingerprint,
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
    return redactSecrets(describeS3Error(e), [s.secretAccessKey]);
  }
}

function foreignFolderMessage(owner: string): string {
  return `This folder in the bucket belongs to another GratisGIS portal (install ${owner.slice(0, 8)}). Give each portal its own folder.`;
}

/**
 * The file's bytes, opened only when first read. A stream opened up
 * front would be left dangling (and raise an unhandled error) when the
 * upload fails before it reads anything.
 */
async function* readLazily(file: string): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(file)) yield chunk as Buffer;
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
    case 'publicKey':
      return 'public key';
    default:
      return f;
  }
}
