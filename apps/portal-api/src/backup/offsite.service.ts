// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
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
  trimSlashes,
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
  artifactTrust,
  checkSignature,
  generateSigningKey,
  parseVerifyKey,
  signingKeyFromSeed,
  signManifest,
  type OffsiteSigningKey,
  type OffsiteVerifyKey,
} from './offsite-sign.js';
import {
  assertEndpointReachable,
  endpointPolicy,
  type EndpointPolicy,
} from './offsite-endpoint.js';
import {
  archiveArtifacts,
  copyAttempt,
  copyObjectName,
  daysSince,
  MAX_COPY_ATTEMPT,
  MAX_SET_ASIDE_CHECKED,
  OFFSITE_LAYOUT,
  partitionByDate,
  selectExpired,
  setAsideReason,
  staleNoticeKey,
  suspectDate,
} from './offsite-rules.js';
import {
  createOffsiteClient,
  deleteObject,
  describeS3Error,
  getSmall,
  headSize,
  listObjects,
  putSmall,
  uploadStream,
  type S3Like,
} from './offsite-store.js';

/** AAD prefixes for the stored secrets; a value cannot move between them. */
const AAD_SECRET = 'backup-offsite:secret-access-key';
const AAD_SIGNING_KEY = 'backup-offsite:signing-key';
/** Earlier verify keys kept, newest last. */
const MAX_PREVIOUS_VERIFY_KEYS = 20;
/** Names of set-aside copies given in one log line or notice. */
const SET_ASIDE_NAMES = 20;

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

/**
 * The longest upload time limit an off-site copy may need: the time
 * between two nightly backups. A backup whose limit is longer is not
 * sent; its off-site copy fails with a message saying so.
 */
export const MAX_UPLOAD_MS = 24 * HOUR_MS;

/** The largest backup whose upload time limit fits in MAX_UPLOAD_MS. */
export const MAX_ARCHIVE_BYTES = Math.floor(((MAX_UPLOAD_MS - 2 * HOUR_MS) / 1000) * 256 * 1024);

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Why a backup of `bytes` is not copied off-site. */
export function tooLargeMessage(bytes: number, limitMs: number): string {
  return `This backup is ${gigabytes(bytes)} GB. Its off-site upload would be allowed ${Math.ceil(limitMs / HOUR_MS)} hours, more than the ${MAX_UPLOAD_MS / HOUR_MS} hours between nightly backups, so no off-site copy was made. The local backup is complete. Off-site copies work for backups up to ${gigabytes(MAX_ARCHIVE_BYTES)} GB.`;
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

/** The signing key, as the page shows it. Its private half never leaves the server. */
export interface OffsiteSigningInfo {
  /** The verify key (ggver1:...), null until the first one is made. */
  verifyKey: string | null;
  fingerprint: string | null;
  changedAt: string | null;
  /** Name of the admin who asked for a new one; null when the server made it. */
  changedBy: string | null;
  /** Fingerprints of earlier verify keys of this portal, newest first. */
  previousFingerprints: string[];
  /** False when the server cannot store a signing key (no CREDENTIAL_ENCRYPTION_KEY). */
  available: boolean;
}

/** What the page shows under the settings. */
export interface OffsiteStatusSummary {
  lastSuccess: {
    runId: string;
    finishedAt: string;
    bytes: string | null;
    keyFingerprint: string | null;
  } | null;
  lastFailure: { runId: string; finishedAt: string | null; error: string | null } | null;
  running: { runId: string; startedAt: string | null } | null;
  /** Days since the last good off-site copy, null when there is none. */
  daysSinceSuccess: number | null;
  alert: boolean;
  /**
   * The newest finished local backup: its size and the time its
   * off-site upload is allowed, so the page shows a backup growing
   * towards the largest one that can be copied.
   */
  lastArchive: {
    runId: string;
    bytes: string;
    uploadLimitMs: number;
    tooLarge: boolean;
  } | null;
  /** The largest backup that can be copied off-site, in bytes. */
  maxArchiveBytes: string;
  /** The longest upload time limit allowed, in milliseconds. */
  maxUploadMs: number;
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
 * - The key it signs copies with (Ed25519, made once): same cipher.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly backup: BackupService,
    @Optional() private readonly notice?: BackupFailureNotice,
    @Optional() private readonly leader?: LeaderElectionService,
  ) {}

  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  onModuleInit() {
    this.backup.onRunSucceeded((info) => this.startUpload(info.runId));
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
    OffsitePublicConfig & {
      status: OffsiteStatusSummary;
      keyChange: OffsiteKeyChange | null;
      signing: OffsiteSigningInfo;
    }
  > {
    const row = await this.ensureInstallId();
    const s = this.resolve(row);
    // The first time off-site copies are set up (here or in the
    // environment), the server makes its signing key, so the page can
    // show the verify key before the first copy.
    if (s.enabled || s.bucket || s.publicKey) await this.ensureSigningKeyQuietly();
    return {
      ...toPublicConfig(s, this.policy()),
      status: await this.statusSummary(s),
      keyChange: await this.keyChange(row),
      signing: await this.signingInfo(),
    };
  }

  /** Make the signing key when it is missing; a failure only leaves it missing. */
  private async ensureSigningKeyQuietly(): Promise<void> {
    if (!credentialKeySet()) return;
    try {
      await this.signingKey();
    } catch (e) {
      this.log.warn(
        `The off-site signing key could not be made: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }

  private async userName(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    try {
      const u = await this.prisma.user.findUnique({
        where: { id },
        select: { fullName: true, username: true },
      });
      return u ? u.fullName || u.username : null;
    } catch {
      return null;
    }
  }

  /** The verify key and its history, for the page. Nothing secret. */
  async signingInfo(): Promise<OffsiteSigningInfo> {
    const row = await this.backup.configRow();
    let verify: OffsiteVerifyKey | null = null;
    try {
      verify = row.offsiteVerifyKey ? parseVerifyKey(row.offsiteVerifyKey) : null;
    } catch {
      verify = null;
    }
    const previous: string[] = [];
    for (const t of [...(row.offsitePreviousVerifyKeys ?? [])].reverse()) {
      try {
        previous.push(parseVerifyKey(t).fingerprintText);
      } catch {
        // A damaged entry is left out.
      }
    }
    return {
      verifyKey: verify?.text ?? null,
      fingerprint: verify?.fingerprintText ?? null,
      changedAt: row.offsiteSigningKeyChangedAt?.toISOString() ?? null,
      changedBy: await this.userName(row.offsiteSigningKeyChangedBy),
      previousFingerprints: previous,
      available: credentialKeySet(),
    };
  }

  /**
   * The key this server signs off-site copies with, made the first
   * time it is needed and stored with the credential cipher under its
   * own associated data. Its private half is never returned, logged,
   * put in a notice or written to the bucket.
   *
   * A stored key that no longer opens (the server key changed) or no
   * longer matches its verify key is replaced, and the operator admins
   * are told: the admin must add the new verify key to their key file.
   */
  async signingKey(): Promise<OffsiteSigningKey> {
    if (!credentialKeySet()) {
      throw new Error(
        'Signing off-site copies needs CREDENTIAL_ENCRYPTION_KEY on this server. Set it, then try again.',
      );
    }
    const row = await this.backup.configRow();
    if (row.offsiteSigningKeyEncrypted && row.offsiteSigningKeyIv) {
      const stored = this.openSigningKey(
        row.offsiteSigningKeyEncrypted,
        row.offsiteSigningKeyIv,
        row.offsiteVerifyKey,
      );
      if ('key' in stored) return stored.key;
      this.log.warn(
        stored.problem === 'unreadable'
          ? 'The stored off-site signing key could not be opened; making a new one. Add the new verify key to your key file.'
          : 'The stored off-site signing key does not match its verify key; making a new one. Add the new verify key to your key file.',
      );
      return (await this.replaceSigningKey(null, 'unreadable')).key;
    }
    const made = generateSigningKey();
    const enc = encryptCredential(made.seed.toString('base64'), AAD_SIGNING_KEY);
    const res = await this.prisma.backupConfig.updateMany({
      where: { id: row.id, offsiteSigningKeyEncrypted: null },
      data: {
        offsiteSigningKeyEncrypted: enc.ciphertext,
        offsiteSigningKeyIv: enc.iv,
        offsiteVerifyKey: made.verifyKey.text,
        offsiteSigningKeyChangedAt: new Date(),
        offsiteSigningKeyChangedBy: null,
      },
    });
    if (res.count === 1) {
      this.log.log(
        `Made the off-site signing key (verify key fingerprint ${made.verifyKey.fingerprintText}). Add the verify key to your key file.`,
      );
      return made;
    }
    // Another process made one first: use that one.
    const again = await this.backup.configRow();
    const theirs =
      again.offsiteSigningKeyEncrypted && again.offsiteSigningKeyIv
        ? this.openSigningKey(
            again.offsiteSigningKeyEncrypted,
            again.offsiteSigningKeyIv,
            again.offsiteVerifyKey,
          )
        : null;
    if (!theirs || !('key' in theirs))
      throw new Error('The off-site signing key could not be stored.');
    return theirs.key;
  }

  /**
   * Open the stored signing key. "unreadable": the seed does not
   * decrypt (the server key changed), so nothing says the stored
   * verify key is wrong. "mismatch": the seed opens, but to another key
   * than the stored verify key, so that verify key is not trusted.
   */
  private openSigningKey(
    ct: string,
    iv: string,
    storedVerify: string | null,
  ): { key: OffsiteSigningKey } | { problem: 'unreadable' | 'mismatch' } {
    let key: OffsiteSigningKey;
    try {
      key = signingKeyFromSeed(Buffer.from(decryptCredential(ct, iv, AAD_SIGNING_KEY), 'base64'));
    } catch {
      return { problem: 'unreadable' };
    }
    return storedVerify === key.verifyKey.text ? { key } : { problem: 'mismatch' };
  }

  /**
   * Make a new signing key. The old verify key is kept in the list of
   * this portal's earlier keys, so copies it signed still count as
   * good for retention, unless the stored key opened to another key
   * than its verify key: a verify key that did not match is never
   * trusted. When the stored key cannot be opened at all (the server
   * key changed), its verify key is kept: it was stored with the key
   * and nothing shows it is wrong. The change is made only if the
   * stored key is still the one read, so two changes at once cannot
   * lose a key. The operator admins get a notice with both
   * fingerprints, saying whether an admin or the server made the
   * change and whether the old verify key is still trusted.
   */
  async replaceSigningKey(
    by: string | null,
    why: 'admin' | 'unreadable' = 'admin',
  ): Promise<{ key: OffsiteSigningKey; from: string | null; to: string }> {
    if (!credentialKeySet()) {
      throw new BadRequestException(
        'This server has no CREDENTIAL_ENCRYPTION_KEY, so it cannot store a signing key.',
      );
    }
    if (why === 'admin' && (await this.otherUploadRunning())) {
      throw new ConflictException('An off-site upload is running. Try again when it finishes.');
    }
    const row = await this.backup.configRow();
    const made = generateSigningKey();
    const enc = encryptCredential(made.seed.toString('base64'), AAD_SIGNING_KEY);
    const current =
      row.offsiteSigningKeyEncrypted && row.offsiteSigningKeyIv
        ? this.openSigningKey(
            row.offsiteSigningKeyEncrypted,
            row.offsiteSigningKeyIv,
            row.offsiteVerifyKey,
          )
        : null;
    // Named in the notice either way.
    let stored: OffsiteVerifyKey | null = null;
    try {
      stored = row.offsiteVerifyKey ? parseVerifyKey(row.offsiteVerifyKey) : null;
    } catch {
      stored = null;
    }
    let keep: OffsiteVerifyKey | null = null;
    if (current && 'key' in current) keep = current.key.verifyKey;
    else if (current && current.problem === 'unreadable') keep = stored;
    const previous = (row.offsitePreviousVerifyKeys ?? []).filter((t) => t !== keep?.text);
    if (keep) previous.push(keep.text);
    const changedAt = new Date();
    const res = await this.prisma.backupConfig.updateMany({
      where: {
        id: row.id,
        offsiteSigningKeyEncrypted: row.offsiteSigningKeyEncrypted ?? null,
        offsiteVerifyKey: row.offsiteVerifyKey ?? null,
      },
      data: {
        offsiteSigningKeyEncrypted: enc.ciphertext,
        offsiteSigningKeyIv: enc.iv,
        offsiteVerifyKey: made.verifyKey.text,
        offsitePreviousVerifyKeys: previous.slice(-MAX_PREVIOUS_VERIFY_KEYS),
        offsiteSigningKeyChangedAt: changedAt,
        offsiteSigningKeyChangedBy: by,
      },
    });
    if (res.count !== 1) {
      // Changed by someone else since it was read.
      if (why === 'unreadable') {
        const again = await this.backup.configRow();
        const theirs =
          again.offsiteSigningKeyEncrypted && again.offsiteSigningKeyIv
            ? this.openSigningKey(
                again.offsiteSigningKeyEncrypted,
                again.offsiteSigningKeyIv,
                again.offsiteVerifyKey,
              )
            : null;
        if (theirs && 'key' in theirs) {
          return {
            key: theirs.key,
            from: stored?.fingerprintText ?? null,
            to: theirs.key.verifyKey.fingerprintText,
          };
        }
      }
      throw new ConflictException(
        'The signing key was changed at the same time by another request. Reload the page and try again.',
      );
    }
    const to = made.verifyKey.fingerprintText;
    const from = stored?.fingerprintText ?? null;
    const oldKeyKept = keep !== null;
    if (why === 'unreadable') {
      this.log.warn(
        `The off-site signing key was replaced automatically (verify key ${from ?? 'none'} is now ${to}). ${
          oldKeyKept
            ? "The old verify key is kept as one of this portal's earlier keys, so copies it signed still count."
            : "The old verify key is not kept as one of this portal's keys."
        } Add the new verify key to your key file.`,
      );
    } else {
      this.log.warn(
        `The off-site signing key was replaced by an admin (verify key ${from ?? 'none'} is now ${to}). Add the new verify key to your key file; copies signed before stay valid with the old one.`,
      );
    }
    try {
      await this.notice?.announceOffsite(`signing:${to}:${changedAt.toISOString()}`, {
        kind: 'offsite_signing_key_changed',
        from,
        to,
        automatic: why === 'unreadable',
        oldKeyKept,
      });
    } catch (e) {
      this.log.warn(
        `The signing key change notice could not be sent: ${e instanceof Error ? e.message : e}`,
      );
    }
    return { key: made, from, to };
  }

  /** This portal's verify keys, current and earlier: the ones its retention trusts. */
  private async ownVerifyKeys(): Promise<OffsiteVerifyKey[]> {
    const row = await this.backup.configRow();
    const out: OffsiteVerifyKey[] = [];
    for (const t of [row.offsiteVerifyKey, ...(row.offsitePreviousVerifyKeys ?? [])]) {
      if (!t) continue;
      try {
        out.push(parseVerifyKey(t));
      } catch {
        // A damaged entry is not trusted.
      }
    }
    return out;
  }

  /**
   * "Check my verify key": does what the admin pastes (a verify key or
   * its fingerprint) match the key this server signs with now, or one
   * it signed with before?
   */
  async checkVerifyKey(value: string): Promise<{
    matches: boolean;
    previous: boolean;
    serverFingerprint: string | null;
    checkedFingerprint: string;
  }> {
    if (looksLikePrivateKey(value)) {
      throw new BadRequestException(
        'That is a private key. Never paste it into the portal. Paste the verify key or its fingerprint.',
      );
    }
    let fp: Buffer | null = parseFingerprint(value);
    if (!fp) {
      try {
        fp = parseVerifyKey(value).fingerprint;
      } catch {
        throw new BadRequestException(
          'Paste a verify key (ggver1:...) or its fingerprint (32 hex digits).',
        );
      }
    }
    const info = await this.signingInfo();
    const text = (fp.toString('hex').match(/.{4}/g) ?? []).join('-');
    return {
      matches: info.fingerprint !== null && info.fingerprint === text,
      previous: info.previousFingerprints.includes(text),
      serverFingerprint: info.fingerprint,
      checkedFingerprint: text,
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
      data.offsiteEndpoint = e === null ? null : trimSlashes(e, false);
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
    // Going back to the environment's endpoint, key id and secret
    // together is not a move: those three were set together.
    const allFromEnvironment =
      next.offsiteEndpoint === null &&
      next.offsiteAccessKeyId === null &&
      (clearing || row.offsiteSecretEncrypted === null);
    if (targetChanged && hadSecret && !typedSecret && !allFromEnvironment) {
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
    await this.ensureSigningKeyQuietly();
    const saved = await this.settings();
    if (keyChanged) {
      this.log.warn(
        `The off-site public key was changed (fingerprint ${keyFrom ?? 'none'} is now ${keyTo ?? 'none'}). New copies use the new key; older copies still open only with the old private key.`,
      );
      if (keyFrom !== null) {
        try {
          await this.notice?.announceOffsite(`key:${keyTo ?? 'none'}:${changedAt.toISOString()}`, {
            kind: 'offsite_key_changed',
            from: keyFrom,
            to: keyTo,
          });
        } catch (e) {
          this.log.warn(
            `The key change notice could not be sent: ${e instanceof Error ? e.message : e}`,
          );
        }
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

  /**
   * Install ids the folder belonged to before, from its marker: the
   * restore expects signed copies from these too.
   */
  private async previousInstallIds(s3: S3Like, s: OffsiteSettings): Promise<string[]> {
    try {
      const j = JSON.parse((await getSmall(s3, s.bucket!, this.markerKey(s))).toString('utf8')) as {
        takenOverFrom?: unknown;
        previousInstallIds?: unknown;
      };
      const ids = [
        ...(Array.isArray(j.previousInstallIds) ? j.previousInstallIds : []),
        j.takenOverFrom,
      ];
      return ids.filter((x): x is string => typeof x === 'string' && x.length === 36);
    } catch {
      return [];
    }
  }

  private async writeInstallMarker(
    s3: S3Like,
    s: OffsiteSettings,
    takenOverFrom: string | null,
    signal?: AbortSignal,
    previousInstallIds: string[] = [],
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
            ...(previousInstallIds.length > 0 ? { previousInstallIds } : {}),
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
    if (await this.otherUploadRunning()) {
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
      const previous = [...new Set([...(await this.previousInstallIds(s3, s)), owner])].slice(-20);
      await this.writeInstallMarker(s3, s, owner, undefined, previous);
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
  async startUpload(runId: string): Promise<UploadHandle | undefined> {
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
    const done = this.upload(runId, s).catch((e: unknown) => {
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
    if (!(await this.claim(runId))) {
      throw new ConflictException(
        'An off-site upload is already running. Try again when it finishes.',
      );
    }
    void this.upload(runId, s).catch((e: unknown) =>
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

  private async upload(runId: string, s: OffsiteSettings): Promise<void> {
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
    const armDeadline = (limit: number) => {
      deadline = setTimeout(() => {
        abort.abort(
          new UploadStop(
            `Stopped: the upload took longer than the ${Math.max(1, Math.round(limit / HOUR_MS))} hour(s) allowed for its size. The storage provider may have stopped answering.`,
          ),
        );
      }, limit);
      deadline.unref?.();
    };
    try {
      const missing = missingSettings(s);
      if (missing.length > 0) {
        throw new Error(`Off-site settings are missing: ${missing.map(fieldLabel).join(', ')}.`);
      }
      if (s.problems.length > 0) throw new Error(s.problems.join(' '));
      const run = await this.prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
      const dir = run.archiveDirectory ?? (await this.backup.getConfig()).archiveDirectory;
      const archivePath = path.join(dir, run.filename!);
      const size = (await fs.stat(archivePath)).size;
      // A backup too large to upload before the next one starts is not
      // sent at all: the copy fails with a message that says so.
      const limit = this.uploadTimeLimit(size);
      if (limit > MAX_UPLOAD_MS) throw new UploadStop(tooLargeMessage(size, limit));
      const policy = this.policy();
      await this.endpointCheck(s.endpoint!, policy);
      if (policy.allowLocal) {
        this.log.warn(
          "BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT is on: off-site copies may go to this server's own loopback address. Turn it off unless this is a test store.",
        );
      }
      if (s.endpoint!.startsWith('http:')) {
        this.log.warn(
          'The off-site endpoint uses plain http (allowed by BACKUP_OFFSITE_ALLOW_HTTP). The files are encrypted, but the bucket keys and names travel unprotected.',
        );
      }
      armDeadline(limit);
      // Every copy is signed; without a signing key nothing is sent.
      const signingKey = await this.signingKey();
      await this.prisma.backupRun.update({
        where: { id: runId },
        data: {
          offsiteKeyFingerprint: s.publicKey!.fingerprintText,
          offsiteVerifyFingerprint: signingKey.verifyKey.fingerprintText,
        },
      });

      const s3 = this.clientFactory(s);
      const signal = abort.signal;
      // Every step waits on the signal too: a request that never
      // answers cannot keep the upload, and its claim, alive.
      const result = await untilAborted(
        (async () => {
          await this.ensureInstallMarker(s3, s, signal);
          const r = await this.uploadArchive({
            s3,
            s,
            publicKey: s.publicKey!,
            signingKey,
            run,
            archivePath,
            size,
            signal,
          });
          // Clean up while this upload still holds the install-wide
          // claim, so no other upload can be using what is removed.
          try {
            await this.enforceRetention(s, s3, signal);
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
          offsiteKeyFingerprint: result.keyFingerprint,
          offsiteVerifyFingerprint: result.verifyFingerprint,
          offsiteFinishedAt: new Date(),
          offsiteError: null,
        },
      });
      this.log.log(
        result.reused
          ? `Off-site copy of backup ${runId} was already complete and signed in the bucket (${result.key}); it was not uploaded again.`
          : `Off-site copy of backup ${runId} uploaded (${result.bytes} bytes, key ${result.keyFingerprint}).`,
      );
    } catch (e) {
      const reason: unknown = abort.signal.aborted ? abort.signal.reason : null;
      const msg =
        reason instanceof UploadStop
          ? reason.message
          : e instanceof UploadStop
            ? e.message
            : this.safeMessage(e, s);
      // Whatever is still in flight stops with the signal.
      if (!abort.signal.aborted) abort.abort(new UploadStop('Stopped.'));
      this.log.error(`Off-site copy of backup ${runId} failed: ${msg}`);
      await this.prisma.backupRun
        .update({
          where: { id: runId },
          data: {
            offsiteStatus: 'failed',
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
   * Upload one backup, or find that an earlier attempt already did.
   *
   * Earlier attempts of the same backup are looked at first. One whose
   * sidecar carries a signature by this portal for this folder, and
   * whose stored size (read with HEAD, nothing downloaded) is the
   * signed size, is complete: it is used as it is. Otherwise the copy
   * goes up under a name no earlier attempt used, so an object that a
   * signed sidecar may describe is never replaced. Leftovers of
   * attempts that never finished (no sidecar, or a sidecar without its
   * copy) are removed only after the new copy and its sidecar are
   * both in the bucket. A complete earlier attempt that does not
   * verify is never removed here; retention sets it aside.
   */
  private async uploadArchive(a: {
    s3: S3Like;
    s: OffsiteSettings;
    publicKey: OffsitePublicKey;
    signingKey: OffsiteSigningKey;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    size: number;
    signal: AbortSignal;
  }): Promise<{
    key: string;
    bytes: number;
    sha256: string;
    keyFingerprint: string;
    verifyFingerprint: string;
    reused: boolean;
  }> {
    if (!a.s.installId) throw new Error('This portal has no install id yet.');
    const archive = a.run.filename!;
    const archivesPrefix = `${a.s.prefix}${OFFSITE_LAYOUT.archives}`;
    const stem = archive.slice(0, -'.tar.gz'.length);
    const listing = [];
    for await (const o of listObjects(a.s3, a.s.bucket!, `${archivesPrefix}${stem}`, a.signal)) {
      listing.push(o);
    }
    const earlier = archiveArtifacts(listing, archivesPrefix).sort(
      (x, y) => copyAttempt(y.id) - copyAttempt(x.id),
    );
    const trusted = await this.ownVerifyKeys();
    for (const c of earlier) {
      if (!c.complete) continue;
      const done = await this.completeEarlierCopy(a.s3, a.s, c.id, trusted, a.signal);
      if (done) return { ...done, reused: true };
    }

    const attempt = earlier.reduce((n, c) => Math.max(n, copyAttempt(c.id)), 0) + 1;
    if (attempt > MAX_COPY_ATTEMPT) {
      throw new Error(
        `This backup was uploaded ${MAX_COPY_ATTEMPT} times without a complete copy. Check the bucket.`,
      );
    }
    const name = copyObjectName(archive, attempt);
    const objectKey = `${archivesPrefix}${name}`;
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
      archive,
      createdAt: a.run.startedAt.toISOString(),
      plainBytes: a.size,
      sealedBytes: up.bytes,
      sealedSha256: up.sha256,
      // Binds the copy's name, folder, portal, size, checksum, key and
      // time; the restore checks it before it decrypts anything.
      signature: signManifest(
        {
          kind: 'archive',
          format: OFFSITE_FORMAT,
          install: a.s.installId,
          prefix: a.s.prefix,
          name: `${OFFSITE_LAYOUT.archives}${name}`,
          bytes: String(up.bytes),
          sha256: up.sha256,
          key: a.publicKey.fingerprintText,
          created: a.run.startedAt.toISOString(),
        },
        a.signingKey,
      ),
    };
    await putSmall(
      a.s3,
      a.s.bucket!,
      `${objectKey}.json`,
      Buffer.from(JSON.stringify(sidecar, null, 2)),
      'application/json',
      a.signal,
    );
    const now = new Date();
    for (const c of earlier) {
      // A complete attempt, or one with a date that cannot be trusted,
      // is never removed here.
      if (c.complete || suspectDate(c, now)) continue;
      try {
        // Sidecar first, as retention does.
        const ordered = [...c.keys].sort(
          (x, y) => Number(y.endsWith('.json')) - Number(x.endsWith('.json')),
        );
        for (const k of ordered) await deleteObject(a.s3, a.s.bucket!, k, a.signal);
      } catch (e) {
        if (a.signal.aborted) throw e;
        this.log.warn(
          `An unfinished earlier upload of ${archive} could not be removed; retention removes it later: ${this.safeMessage(e, a.s)}`,
        );
      }
    }
    return {
      key: objectKey,
      bytes: up.bytes,
      sha256: up.sha256,
      keyFingerprint: a.publicKey.fingerprintText,
      verifyFingerprint: a.signingKey.verifyKey.fingerprintText,
      reused: false,
    };
  }

  /**
   * An earlier attempt that is complete: its sidecar is signed by one
   * of this portal's verify keys for this folder, portal install and
   * name, and the stored size is the signed size. Null otherwise.
   */
  private async completeEarlierCopy(
    s3: S3Like,
    s: OffsiteSettings,
    id: string,
    trusted: readonly OffsiteVerifyKey[],
    signal: AbortSignal,
  ): Promise<{
    key: string;
    bytes: number;
    sha256: string;
    keyFingerprint: string;
    verifyFingerprint: string;
  } | null> {
    const objectKey = `${s.prefix}${OFFSITE_LAYOUT.archives}${id}`;
    let sidecar: unknown;
    try {
      sidecar = JSON.parse(
        (await getSmall(s3, s.bucket!, `${objectKey}.json`, signal)).toString('utf8'),
      );
    } catch (e) {
      if (signal.aborted) throw e;
      return null;
    }
    const check = checkSignature(sidecar, trusted, {
      prefix: s.prefix,
      name: `${OFFSITE_LAYOUT.archives}${id}`,
      installIds: s.installId ? [s.installId] : [],
    });
    if (check.trust !== 'verified' || !check.manifest || !check.signer) return null;
    const bytes = Number(check.manifest.bytes);
    if ((await headSize(s3, s.bucket!, objectKey, signal)) !== bytes) return null;
    return {
      key: objectKey,
      bytes,
      sha256: check.manifest.sha256,
      keyFingerprint: check.manifest.key,
      verifyFingerprint: check.signer,
    };
  }

  // ---------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------

  /** An off-site upload holds the claim and is alive. */
  private async otherUploadRunning(): Promise<boolean> {
    const other = await this.prisma.backupRun.findFirst({
      where: { offsiteStatus: 'running' },
      select: { id: true },
    });
    return other !== null;
  }

  /**
   * Delete off-site copies older than the retention window, never the
   * newest good one. Only names this feature writes, under this
   * portal's own folder, are touched. Bucket versioning or object lock
   * at the provider is what protects history from a compromised
   * server; see the help page.
   *
   * Every sidecar is read before anything is deleted. One that cannot
   * be read or parsed stops the pass: nothing is deleted, and it is
   * reported once (see reportStopped). Copies set aside (a bad
   * signature, or a date that cannot be trusted) are kept and
   * reported, never deleted.
   */
  async enforceRetention(
    s: OffsiteSettings,
    s3: S3Like = this.clientFactory(s),
    signal?: AbortSignal,
  ): Promise<number> {
    const now = new Date();
    const stop = () => {
      if (signal?.aborted) throw signal.reason as Error;
    };
    // Another portal may have taken the folder over since the upload
    // started: then its retention applies, not this one's.
    const owner = await this.readInstallMarker(s3, s, signal);
    if (!s.installId || owner !== s.installId) {
      this.log.warn(
        `This portal no longer owns the off-site folder ${s.prefix}; nothing in it was removed.`,
      );
      return 0;
    }
    const archivesPrefix = `${s.prefix}${OFFSITE_LAYOUT.archives}`;
    const listing = [];
    for await (const o of listObjects(s3, s.bucket!, archivesPrefix, signal)) listing.push(o);
    const all = archiveArtifacts(listing, archivesPrefix).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    // Only signed copies this portal can verify count as good; a copy
    // with a bad signature is set aside like a future-dated one. Newest
    // first; after MAX_SET_ASIDE_CHECKED bad ones, older complete copies
    // are left out of this pass (never deleted, checked next time).
    const trusted = await this.ownVerifyKeys();
    const artifacts: typeof all = [];
    let bad = 0;
    let unchecked = 0;
    for (const a of all) {
      if (!a.complete || suspectDate(a, now)) {
        artifacts.push(a);
        continue;
      }
      if (bad >= MAX_SET_ASIDE_CHECKED) {
        unchecked += 1;
        continue;
      }
      stop();
      let sidecar: unknown = null;
      try {
        sidecar = JSON.parse(
          (await getSmall(s3, s.bucket!, `${archivesPrefix}${a.id}.json`, signal)).toString('utf8'),
        );
      } catch (e) {
        if (signal?.aborted) throw e;
        sidecar = null;
      }
      if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
        await this.reportStopped(a.id, now);
        return 0;
      }
      a.trust = artifactTrust(
        checkSignature(sidecar, trusted, {
          prefix: s.prefix,
          name: `${OFFSITE_LAYOUT.archives}${a.id}`,
          bytes: a.sealedBytes,
        }),
        sidecar,
        s.installId,
      );
      if (a.trust === 'bad') bad += 1;
      artifacts.push(a);
    }
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
    if (unchecked > 0) {
      this.log.warn(
        `${unchecked} older off-site copies were not checked this pass because many copies were set aside; they were kept.`,
      );
    }
    await this.reportSetAside(
      partitionByDate(artifacts, now).suspect.map((a) => ({
        id: a.id,
        why: setAsideReason(a, now),
      })),
    );
    if (removed > 0) this.log.log(`Off-site retention removed ${removed} object(s).`);
    return removed;
  }

  /**
   * A sidecar that could not be read or parsed stops the retention
   * pass with nothing deleted. One log line per pass, and at most one
   * notice a day.
   */
  private async reportStopped(id: string, now: Date): Promise<void> {
    this.log.warn(
      `Off-site retention stopped: the record of copy ${id} could not be read. Nothing was deleted. Check the bucket.`,
    );
    try {
      await this.notice?.announceOffsite(`retention-stopped:${now.toISOString().slice(0, 10)}`, {
        kind: 'offsite_retention_stopped',
        name: id,
      });
    } catch {
      // The log line above stands.
    }
  }

  /**
   * Copies set aside this pass (dated in the future, or after the
   * provider recorded them, or with a bad signature): kept, never
   * counted as the newest copy. One log line and one summary notice
   * per pass, with counts and at most SET_ASIDE_NAMES names; the same
   * set of copies is not announced twice.
   */
  private async reportSetAside(
    copies: Array<{ id: string; why: 'future' | 'after-upload' | 'bad-signature' | null }>,
  ): Promise<void> {
    if (copies.length === 0) return;
    const badSignature = copies.filter((c) => c.why === 'bad-signature').length;
    const dated = copies.length - badSignature;
    const ids = copies.map((c) => c.id).sort();
    const names = ids.slice(0, SET_ASIDE_NAMES).join(', ');
    const more = ids.length > SET_ASIDE_NAMES ? ` and ${ids.length - SET_ASIDE_NAMES} more` : '';
    this.log.warn(
      `${copies.length} off-site copies were set aside (${badSignature} not signed by this portal or not matching their signature, ${dated} with a date that cannot be trusted): ${names}${more}. They were kept: not deleted and not counted as the newest copy. Check who can write to the bucket.`,
    );
    const digest = createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 32);
    try {
      await this.notice?.announceOffsite(`set-aside:${digest}`, {
        kind: 'offsite_set_aside',
        count: copies.length,
        badSignature,
        dated,
        name: `${names}${more}`,
      });
    } catch {
      // The log line above stands.
    }
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
    const newest = await this.prisma.backupRun.findFirst({
      where: { status: 'succeeded', sizeBytes: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, sizeBytes: true },
    });
    const newestBytes = newest?.sizeBytes == null ? null : Number(newest.sizeBytes);
    const newestLimit = newestBytes === null ? null : this.uploadTimeLimit(newestBytes);
    return {
      lastSuccess: last?.offsiteFinishedAt
        ? {
            runId: last.id,
            finishedAt: last.offsiteFinishedAt.toISOString(),
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
      lastArchive:
        newest && newestBytes !== null && newestLimit !== null
          ? {
              runId: newest.id,
              bytes: String(newestBytes),
              uploadLimitMs: newestLimit,
              tooLarge: newestLimit > MAX_UPLOAD_MS,
            }
          : null,
      maxArchiveBytes: String(MAX_ARCHIVE_BYTES),
      maxUploadMs: MAX_UPLOAD_MS,
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

function credentialKeySet(): boolean {
  try {
    assertCredentialKeyConfigured();
    return true;
  } catch {
    return false;
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
