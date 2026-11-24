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
  envSecret,
  missingSettings,
  normalizePrefix,
  OFFSITE_ENV,
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
import {
  assertEndpointReachable,
  endpointPolicy,
  type EndpointPolicy,
} from './offsite-endpoint.js';
import { OffsiteMirror, PrismaMirrorIndex, type MirrorIndexStore } from './offsite-mirror.js';
import {
  archiveArtifacts,
  daysSince,
  OFFSITE_LAYOUT,
  partitionByDate,
  selectExpired,
  staleNoticeKey,
  suspectDate,
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
const HOUR_MS = 60 * 60 * 1000;

/**
 * The longest one off-site upload may take: two hours, plus the time
 * to send its bytes at 256 KiB/s (about 2 Mbit/s). Past it the upload
 * is stopped and marked failed, so a provider that stops answering
 * cannot hold the install-wide upload claim.
 */
export function uploadTimeLimitMs(bytes: number): number {
  return 2 * HOUR_MS + Math.ceil((Math.max(0, bytes) / (256 * 1024)) * 1000);
}

/** Why an upload was stopped from outside its own steps. */
class UploadStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadStop';
  }
}

/** Rejects as soon as the signal fires, whatever `work` is waiting on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      },
    );
  });
}

export type OffsiteMode = 'archive' | 'mirror';

/** What the run-succeeded hook gets back: the upload, still running. */
export interface UploadHandle {
  done: Promise<void>;
}

/** The last change of the saved public key. */
export interface OffsiteKeyChange {
  at: string;
  /** Name of the admin who saved it, when known. */
  by: string | null;
  previousFingerprint: string | null;
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
  /** Swapped in tests: the longest an upload of `bytes` may take. */
  uploadTimeLimit: (bytes: number) => number = uploadTimeLimitMs;
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
  private resolve(
    row: OffsiteRow & { offsiteSecretEncrypted: string | null; offsiteSecretIv: string | null },
  ) {
    const policy = this.policy();
    // The endpoint and key id first: the secret is bound to them.
    const plain = resolveOffsiteSettings(row, { secretFromDb: null }, this.env, policy);
    const secretFromDb = this.tryDecrypt(
      row.offsiteSecretEncrypted,
      row.offsiteSecretIv,
      secretAad(plain.endpoint, plain.accessKeyId),
      'secret access key',
    );
    // A saved secret that no longer opens is not replaced by the
    // environment's: that would send the environment's secret to an
    // endpoint saved for another one.
    const storedSecretUnreadable =
      !!row.offsiteSecretEncrypted && !!row.offsiteSecretIv && secretFromDb === null;
    return resolveOffsiteSettings(row, { secretFromDb, storedSecretUnreadable }, this.env, policy);
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

  async getPublicConfig(): Promise<
    OffsitePublicConfig & { status: OffsiteStatusSummary; keyChange: OffsiteKeyChange | null }
  > {
    const row = await this.ensureInstallId();
    const s = this.resolve(row);
    return {
      ...toPublicConfig(s, this.policy()),
      status: await this.statusSummary(s),
      keyChange: await this.keyChange(row),
    };
  }

  /** The last change of the saved public key, for the page. */
  private async keyChange(row: {
    offsiteKeyChangedAt?: Date | null;
    offsiteKeyChangedBy?: string | null;
    offsitePreviousFingerprint?: string | null;
  }): Promise<OffsiteKeyChange | null> {
    if (!row.offsiteKeyChangedAt) return null;
    let by: string | null = null;
    if (row.offsiteKeyChangedBy) {
      try {
        const u = await this.prisma.user.findUnique({
          where: { id: row.offsiteKeyChangedBy },
          select: { fullName: true, username: true },
        });
        by = u ? u.fullName || u.username : null;
      } catch {
        by = null;
      }
    }
    return {
      at: row.offsiteKeyChangedAt.toISOString(),
      by,
      previousFingerprint: row.offsitePreviousFingerprint ?? null,
    };
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
    // Clearing a saved secret hands over to the one in the server
    // environment. That counts as a new target: it is allowed only when
    // the endpoint and key id also come from the environment after this
    // save, so a secret typed for one endpoint and then cleared cannot
    // bring the environment's secret along to it.
    const envSecretSet =
      envSecret(this.env, OFFSITE_ENV.secretAccessKey, OFFSITE_ENV.secretAccessKeyFile) !== null;
    if (
      clearing &&
      envSecretSet &&
      row.offsiteSecretEncrypted !== null &&
      (next.offsiteEndpoint !== null || next.offsiteAccessKeyId !== null)
    ) {
      throw new BadRequestException(
        'The server environment also sets a secret access key. To use it again, clear the endpoint and the access key id on this page in the same save, so all three come from the environment; or type the secret for this endpoint.',
      );
    }

    // A changed key is recorded with who changed it and the fingerprint
    // it replaced, and announced to the operator admins below.
    const keyFrom = before.publicKey?.fingerprintText ?? null;
    const keyTo = after.publicKey?.fingerprintText ?? null;
    const keyChanged = keyFrom !== keyTo;
    const changedAt = new Date();
    if (keyChanged) {
      data.offsiteKeyChangedAt = changedAt;
      data.offsiteKeyChangedBy = updatedBy;
      data.offsitePreviousFingerprint = keyFrom;
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
    if (keyChanged) {
      this.log.warn(
        `The off-site public key was changed (fingerprint ${keyFrom ?? 'none'} is now ${keyTo ?? 'none'}). New copies use the new key; older copies still open only with the old private key.`,
      );
      if (keyFrom !== null) {
        await this.notice
          ?.announceOffsite(`key:${keyTo ?? 'none'}:${changedAt.toISOString()}`, {
            kind: 'offsite_key_changed',
            from: keyFrom,
            to: keyTo,
          })
          .catch((e: unknown) =>
            this.log.warn(
              `The key change notice could not be sent: ${e instanceof Error ? e.message : e}`,
            ),
          );
      }
    }
    this.log.log(
      `Off-site backup settings saved (enabled=${saved.enabled}, complete=${missingSettings(saved).length === 0}${saved.publicKey ? `, key ${saved.publicKey.fingerprintText}` : ''}).`,
    );
    return {
      ...(await this.getPublicConfig()),
      savedKeyChange: keyChanged ? { from: keyFrom, to: keyTo } : null,
    };
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
  private async readInstallMarker(
    s3: S3Like,
    s: OffsiteSettings,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let buf: Buffer;
    try {
      buf = await getSmall(s3, s.bucket!, this.markerKey(s), signal);
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
  private async ensureInstallMarker(
    s3: S3Like,
    s: OffsiteSettings,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!s.installId) throw new Error('This portal has no install id yet.');
    const owner = await this.readInstallMarker(s3, s, signal);
    if (owner === s.installId) return;
    if (owner !== null) throw new Error(foreignFolderMessage(owner));
    await this.writeInstallMarker(s3, s, null, signal);
  }

  private async writeInstallMarker(
    s3: S3Like,
    s: OffsiteSettings,
    takenOverFrom: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    await putSmall(
      s3,
      s.bucket!,
      this.markerKey(s),
      Buffer.from(
        JSON.stringify(
          {
            kind: 'gratisgis-offsite-folder',
            installId: s.installId,
            createdAt: new Date().toISOString(),
            ...(takenOverFrom ? { takenOverFrom } : {}),
          },
          null,
          2,
        ),
      ),
      'application/json',
      signal,
    );
  }

  /**
   * "Take over this folder": after a restore on a new server, the
   * portal has a new install id and the folder still names the old
   * one. The admin confirms by typing the first 8 characters of the
   * old id, which the refusal message shows. Nothing in the folder is
   * deleted; from then on this portal's retention applies to it.
   */
  async takeOverFolder(typedOwner: string): Promise<{ previousOwner: string }> {
    const s = await this.settings();
    const missing = missingSettings(s).filter((m) => m !== 'publicKey');
    if (missing.length > 0 || s.problems.length > 0) {
      throw new ConflictException(
        [missing.length ? `Fill in: ${missing.map(fieldLabel).join(', ')}.` : '', ...s.problems]
          .filter(Boolean)
          .join(' '),
      );
    }
    if (await this.otherUploadRunning(null)) {
      throw new ConflictException('An off-site upload is running. Try again when it finishes.');
    }
    await this.endpointCheck(s.endpoint!, this.policy());
    const s3 = this.clientFactory(s);
    let owner: string | null;
    try {
      owner = await this.readInstallMarker(s3, s);
    } catch (e) {
      throw new ConflictException(this.safeMessage(e, s));
    }
    if (owner === null) {
      throw new ConflictException(
        'This folder has no owner yet. Turn off-site copies on and the next copy claims it.',
      );
    }
    if (owner === s.installId) throw new ConflictException('This portal already owns the folder.');
    const short = owner.slice(0, 8).toLowerCase();
    if (typedOwner.trim().toLowerCase() !== short) {
      throw new BadRequestException(
        `Type ${short}, the start of the install id that owns the folder now, to take it over.`,
      );
    }
    try {
      await this.writeInstallMarker(s3, s, owner);
    } catch (e) {
      throw new ConflictException(this.safeMessage(e, s));
    }
    this.log.warn(`This portal took over the off-site folder ${s.prefix} from install ${short}.`);
    return { previousOwner: short };
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
      this.log.warn(
        `Off-site copy of backup ${runId} not started: another off-site upload is running.`,
      );
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
    const bytes =
      objectBytes ?? (await this.objectBytesFromManifest(path.join(dir, run.filename!)));
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
          if ((e as { code?: string }).code === 'P2025') {
            abort.abort(
              new UploadStop(
                'Stopped: the backup was deleted while its off-site copy was uploading.',
              ),
            );
          }
        });
    }, this.beatEveryMs);
    timer.unref?.();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (bytes: number) => {
      const limit = this.uploadTimeLimit(bytes);
      deadline = setTimeout(() => {
        abort.abort(
          new UploadStop(
            `Stopped: the upload took longer than the ${Math.max(1, Math.round(limit / HOUR_MS))} hour(s) allowed for its size. The storage provider may have stopped answering.`,
          ),
        );
      }, limit);
      deadline.unref?.();
    };
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
      armDeadline(size + (mode === 'mirror' ? (objectBytes ?? 0) : 0));
      await this.prisma.backupRun.update({
        where: { id: runId },
        data: { offsiteMode: mode, offsiteKeyFingerprint: s.publicKey!.fingerprintText },
      });

      const s3 = this.clientFactory(s);
      const signal = abort.signal;
      // Every step waits on the signal too: a request that never
      // answers cannot keep the upload, and its claim, alive.
      const result = await untilAborted(
        (async () => {
          await this.ensureInstallMarker(s3, s, signal);
          const r =
            mode === 'mirror'
              ? await this.mirror.upload({
                  s3,
                  s,
                  publicKey: s.publicKey!,
                  nameKey: await this.nameKey(),
                  index: this.index,
                  run,
                  archivePath,
                  signal,
                })
              : await this.uploadArchive({
                  s3,
                  s,
                  publicKey: s.publicKey!,
                  run,
                  archivePath,
                  size,
                  signal,
                });
          // Clean up while this upload still holds the install-wide
          // claim, so no other upload can be using what is removed.
          try {
            await this.enforceRetention(s, s3, runId, signal);
          } catch (e) {
            if (signal.aborted) throw e;
            this.log.warn(`Off-site retention failed: ${this.safeMessage(e, s)}`);
          }
          return r;
        })(),
        signal,
      );
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
      const reason: unknown = abort.signal.aborted ? abort.signal.reason : null;
      const msg = reason instanceof UploadStop ? reason.message : this.safeMessage(e, s);
      // Whatever is still in flight stops with the signal.
      if (!abort.signal.aborted) abort.abort(new UploadStop('Stopped.'));
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
      if (deadline) clearTimeout(deadline);
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
      'application/json',
      a.signal,
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
    signal?: AbortSignal,
  ): Promise<number> {
    const now = new Date();
    const stop = () => {
      if (signal?.aborted) throw signal.reason as Error;
    };
    const archivesPrefix = `${s.prefix}${OFFSITE_LAYOUT.archives}`;
    const listing = [];
    for await (const o of listObjects(s3, s.bucket!, archivesPrefix, signal)) listing.push(o);
    const artifacts = archiveArtifacts(listing, archivesPrefix);
    let removed = 0;
    for (const id of selectExpired(artifacts, now, s.retentionDays)) {
      const a = artifacts.find((x) => x.id === id)!;
      // Sidecar first, so a half-deleted copy never reads as complete.
      const ordered = [...a.keys].sort(
        (x, y) => Number(y.endsWith('.json')) - Number(x.endsWith('.json')),
      );
      for (const k of ordered) {
        stop();
        await deleteObject(s3, s.bucket!, k, signal);
        removed += 1;
      }
    }
    stop();
    const collect = !(await this.otherUploadRunning(self));
    if (!collect)
      this.log.log('Another off-site upload is running; mirror files are not collected this time.');
    const m = await this.mirror.enforceRetention(s, s3, now, this.index, collect);
    removed += m.removed;
    if (m.unknownKept > 0) {
      this.log.log(
        `${m.unknownKept} mirrored file(s) in the bucket are not in this server's index and were kept. A bucket lifecycle rule can remove them once they are older than your retention window.`,
      );
    }
    const suspect = [
      ...partitionByDate(artifacts, now).suspect.map((a) => ({
        id: a.id,
        why: suspectDate(a, now),
      })),
      ...m.suspect.map((r) => ({ id: `mirror:${r.id}`, why: r.why })),
    ];
    for (const x of suspect) await this.reportSuspect(x.id, x.why);
    if (removed > 0) this.log.log(`Off-site retention removed ${removed} object(s).`);
    return removed;
  }

  /**
   * A copy whose name is dated in the future, or well after the
   * provider says it was written, was not made by this portal's clock.
   * It is kept, never counted as the newest copy, and reported once.
   */
  private async reportSuspect(id: string, why: string | null): Promise<void> {
    this.log.warn(
      `Off-site copy ${id} is dated ${why === 'future' ? 'in the future' : 'after the provider recorded its upload'}. It was not used or deleted. Check who can write to the bucket.`,
    );
    await this.notice
      ?.announceOffsite(`suspect:${id}`, { kind: 'offsite_suspect_copy', name: id })
      .catch(() => undefined);
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
  return `This folder in the bucket belongs to another GratisGIS portal (install ${owner.slice(0, 8)}). Give each portal its own folder. If this portal was restored from that one and replaces it, use "Take over this folder" on the Backup page.`;
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
