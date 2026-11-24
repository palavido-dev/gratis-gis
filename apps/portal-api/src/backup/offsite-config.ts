// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';

/**
 * Off-site backup settings: what the admin page edits, what the
 * environment can supply instead, and the checks both go through.
 *
 * Each setting is the database value when one is saved, otherwise the
 * BACKUP_OFFSITE_* environment variable. The two secrets (the bucket's
 * secret access key and the encryption passphrase) follow the same
 * order, and the environment may name a file with the *_FILE variant.
 * Neither secret ever leaves this process through the API: callers get
 * the public view, which says only whether each one is set and where
 * it came from.
 */

export const OFFSITE_ENV = {
  enabled: 'BACKUP_OFFSITE_ENABLED',
  endpoint: 'BACKUP_OFFSITE_ENDPOINT',
  region: 'BACKUP_OFFSITE_REGION',
  bucket: 'BACKUP_OFFSITE_BUCKET',
  prefix: 'BACKUP_OFFSITE_PREFIX',
  pathStyle: 'BACKUP_OFFSITE_PATH_STYLE',
  accessKeyId: 'BACKUP_OFFSITE_ACCESS_KEY_ID',
  secretAccessKey: 'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
  secretAccessKeyFile: 'BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE',
  passphrase: 'BACKUP_OFFSITE_PASSPHRASE',
  passphraseFile: 'BACKUP_OFFSITE_PASSPHRASE_FILE',
  retentionDays: 'BACKUP_OFFSITE_RETENTION_DAYS',
  alertDays: 'BACKUP_OFFSITE_ALERT_DAYS',
  mirrorThresholdGb: 'BACKUP_OFFSITE_MIRROR_THRESHOLD_GB',
} as const;

export const OFFSITE_DEFAULTS = {
  region: 'us-east-1',
  prefix: 'gratisgis/',
  pathStyle: true,
  retentionDays: 30,
  alertDays: 3,
  mirrorThresholdBytes: 50 * 1024 ** 3,
} as const;

export const PASSPHRASE_MIN = 16;
export const PASSPHRASE_MAX = 1024;

export type SecretSource = 'database' | 'environment' | null;

/** Effective settings, secrets included. Server side only. */
export interface OffsiteSettings {
  enabled: boolean;
  endpoint: string | null;
  region: string;
  bucket: string | null;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  secretSource: SecretSource;
  passphrase: string | null;
  passphraseSource: SecretSource;
  retentionDays: number;
  alertDays: number;
  mirrorThresholdBytes: number;
}

/** What the API returns. No secret values, by construction. */
export interface OffsitePublicConfig {
  enabled: boolean;
  endpoint: string | null;
  region: string;
  bucket: string | null;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string | null;
  hasSecretAccessKey: boolean;
  secretAccessKeySource: SecretSource;
  hasPassphrase: boolean;
  passphraseSource: SecretSource;
  retentionDays: number;
  alertDays: number;
  mirrorThresholdBytes: number;
  /** Everything needed to upload is present. */
  complete: boolean;
  /** Plain reasons it is not complete, for the page. */
  missing: string[];
}

/** Columns of backup_config this module reads. */
export interface OffsiteRow {
  offsiteEnabled: boolean | null;
  offsiteEndpoint: string | null;
  offsiteRegion: string | null;
  offsiteBucket: string | null;
  offsitePrefix: string | null;
  offsitePathStyle: boolean | null;
  offsiteAccessKeyId: string | null;
  offsiteRetentionDays: number | null;
  offsiteAlertDays: number | null;
  offsiteMirrorThresholdBytes: bigint | null;
}

export type EnvReader = (name: string) => string | undefined;

function envText(env: EnvReader, name: string): string | null {
  const v = env(name)?.trim();
  return v ? v : null;
}

function envBool(env: EnvReader, name: string): boolean | null {
  const v = envText(env, name)?.toLowerCase();
  if (v === undefined || v === null) return null;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

function envInt(env: EnvReader, name: string): number | null {
  const v = envText(env, name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A secret from the environment: the variable itself, or the file the
 * *_FILE variable names. One trailing newline is dropped from a file,
 * since editors add one; anything else is kept as written.
 */
export function envSecret(
  env: EnvReader,
  name: string,
  fileName: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): string | null {
  const direct = env(name);
  if (direct && direct.length > 0) return direct;
  const file = envText(env, fileName);
  if (!file) return null;
  try {
    const raw = readFile(file).replace(/\r?\n$/, '');
    return raw.length > 0 ? raw : null;
  } catch {
    // The path is the operator's; say nothing about it beyond "unset".
    return null;
  }
}

/** Merge the saved row over the environment. */
export function resolveOffsiteSettings(
  row: OffsiteRow,
  secrets: {
    secretFromDb: string | null;
    passphraseFromDb: string | null;
  },
  env: EnvReader,
  readFile?: (p: string) => string,
): OffsiteSettings {
  const secretEnv = envSecret(
    env,
    OFFSITE_ENV.secretAccessKey,
    OFFSITE_ENV.secretAccessKeyFile,
    readFile,
  );
  const passEnv = envSecret(env, OFFSITE_ENV.passphrase, OFFSITE_ENV.passphraseFile, readFile);
  const gb = envInt(env, OFFSITE_ENV.mirrorThresholdGb);
  return {
    enabled: row.offsiteEnabled ?? envBool(env, OFFSITE_ENV.enabled) ?? false,
    endpoint: row.offsiteEndpoint ?? envText(env, OFFSITE_ENV.endpoint),
    region: row.offsiteRegion ?? envText(env, OFFSITE_ENV.region) ?? OFFSITE_DEFAULTS.region,
    bucket: row.offsiteBucket ?? envText(env, OFFSITE_ENV.bucket),
    prefix: normalizePrefix(
      row.offsitePrefix ?? envText(env, OFFSITE_ENV.prefix) ?? OFFSITE_DEFAULTS.prefix,
    ),
    pathStyle:
      row.offsitePathStyle ?? envBool(env, OFFSITE_ENV.pathStyle) ?? OFFSITE_DEFAULTS.pathStyle,
    accessKeyId: row.offsiteAccessKeyId ?? envText(env, OFFSITE_ENV.accessKeyId),
    secretAccessKey: secrets.secretFromDb ?? secretEnv,
    secretSource: secrets.secretFromDb ? 'database' : secretEnv ? 'environment' : null,
    passphrase: secrets.passphraseFromDb ?? passEnv,
    passphraseSource: secrets.passphraseFromDb ? 'database' : passEnv ? 'environment' : null,
    retentionDays:
      row.offsiteRetentionDays ??
      envInt(env, OFFSITE_ENV.retentionDays) ??
      OFFSITE_DEFAULTS.retentionDays,
    alertDays:
      row.offsiteAlertDays ?? envInt(env, OFFSITE_ENV.alertDays) ?? OFFSITE_DEFAULTS.alertDays,
    mirrorThresholdBytes:
      row.offsiteMirrorThresholdBytes !== null
        ? Number(row.offsiteMirrorThresholdBytes)
        : gb !== null
          ? gb * 1024 ** 3
          : OFFSITE_DEFAULTS.mirrorThresholdBytes,
  };
}

/** Empty, or ends in exactly one slash, never starts with one. */
export function normalizePrefix(p: string): string {
  const trimmed = p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

export function missingSettings(s: OffsiteSettings): string[] {
  const out: string[] = [];
  if (!s.endpoint) out.push('endpoint');
  if (!s.bucket) out.push('bucket');
  if (!s.accessKeyId) out.push('accessKeyId');
  if (!s.secretAccessKey) out.push('secretAccessKey');
  if (!s.passphrase) out.push('passphrase');
  return out;
}

export function toPublicConfig(s: OffsiteSettings): OffsitePublicConfig {
  const missing = missingSettings(s);
  return {
    enabled: s.enabled,
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    prefix: s.prefix,
    pathStyle: s.pathStyle,
    accessKeyId: s.accessKeyId,
    hasSecretAccessKey: s.secretAccessKey !== null,
    secretAccessKeySource: s.secretSource,
    hasPassphrase: s.passphrase !== null,
    passphraseSource: s.passphraseSource,
    retentionDays: s.retentionDays,
    alertDays: s.alertDays,
    mirrorThresholdBytes: s.mirrorThresholdBytes,
    complete: missing.length === 0,
    missing,
  };
}

/** Patch the admin page sends. Undefined keeps; null clears. */
export interface OffsitePatch {
  enabled?: boolean | null;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  prefix?: string | null;
  pathStyle?: boolean | null;
  accessKeyId?: string | null;
  /** New secret. Empty string or null clears the saved one. */
  secretAccessKey?: string | null;
  /** New passphrase. Empty string or null clears the saved one. */
  passphrase?: string | null;
  /** Must equal `passphrase` when that is set. */
  passphraseConfirm?: string | null;
  retentionDays?: number | null;
  alertDays?: number | null;
  mirrorThresholdBytes?: number | null;
}

export class OffsiteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffsiteValidationError';
  }
}

/** True when the text has a control character (code below 32, or 127). */
function hasControl(text: string, alsoSpace = false): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 127 || (alsoSpace && c === 32)) return true;
  }
  return false;
}

// S3 bucket naming, loose enough for B2, R2 and Hetzner.
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{1,40}$/i;
const ACCESS_KEY_RE = /^[\x21-\x7e]{3,256}$/;

/**
 * Check a patch before anything is written. Throws a plain sentence
 * the page can show; never includes a secret value in the message.
 */
export function validateOffsitePatch(patch: OffsitePatch, opts: { allowHttp: boolean }): void {
  if (typeof patch.endpoint === 'string' && patch.endpoint.trim()) {
    let u: URL;
    try {
      u = new URL(patch.endpoint.trim());
    } catch {
      throw new OffsiteValidationError(
        'The endpoint must be a full URL, such as https://s3.eu-central-003.backblazeb2.com.',
      );
    }
    if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) {
      throw new OffsiteValidationError('The endpoint must use https.');
    }
    if (u.username || u.password) {
      throw new OffsiteValidationError(
        'Put the keys in their own fields, not in the endpoint URL.',
      );
    }
    if (u.search || u.hash || (u.pathname && u.pathname !== '/')) {
      throw new OffsiteValidationError(
        'The endpoint is the server address only, without a path. Put the bucket name in the bucket field.',
      );
    }
  }
  if (
    typeof patch.bucket === 'string' &&
    patch.bucket.trim() &&
    !BUCKET_RE.test(patch.bucket.trim())
  ) {
    throw new OffsiteValidationError(
      'The bucket name can use lower-case letters, digits, dots and hyphens, 3 to 63 characters.',
    );
  }
  if (
    typeof patch.region === 'string' &&
    patch.region.trim() &&
    !REGION_RE.test(patch.region.trim())
  ) {
    throw new OffsiteValidationError(
      "The region looks wrong. Use the provider's region name, such as us-east-1 or auto.",
    );
  }
  if (typeof patch.prefix === 'string') {
    const p = patch.prefix.trim();
    if (p.length > 200 || p.includes('\\') || hasControl(p) || /(^|\/)\.\.?(\/|$)/.test(p)) {
      throw new OffsiteValidationError(
        'The folder prefix can be up to 200 characters, with no backslashes, control characters, or "." or ".." parts.',
      );
    }
  }
  if (
    typeof patch.accessKeyId === 'string' &&
    patch.accessKeyId.trim() &&
    !ACCESS_KEY_RE.test(patch.accessKeyId.trim())
  ) {
    throw new OffsiteValidationError('The access key id has characters that are not allowed.');
  }
  if (typeof patch.secretAccessKey === 'string' && patch.secretAccessKey.length > 0) {
    if (patch.secretAccessKey.length > 512 || hasControl(patch.secretAccessKey, true)) {
      throw new OffsiteValidationError(
        'The secret access key has spaces or characters that are not allowed.',
      );
    }
  }
  if (typeof patch.passphrase === 'string' && patch.passphrase.length > 0) {
    validatePassphrase(patch.passphrase);
    if (patch.passphraseConfirm !== patch.passphrase) {
      throw new OffsiteValidationError('The two passphrases do not match.');
    }
  }
  const intRange = (name: string, v: number | null | undefined, lo: number, hi: number) => {
    if (v === undefined || v === null) return;
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new OffsiteValidationError(`${name} must be a whole number from ${lo} to ${hi}.`);
    }
  };
  intRange('Days to keep off-site copies', patch.retentionDays, 1, 3650);
  intRange('Days before a missing off-site copy is reported', patch.alertDays, 1, 90);
  if (patch.mirrorThresholdBytes !== undefined && patch.mirrorThresholdBytes !== null) {
    const v = patch.mirrorThresholdBytes;
    if (!Number.isSafeInteger(v) || v < 1024 ** 3 || v > 1024 ** 5) {
      throw new OffsiteValidationError('The mirror threshold must be between 1 GB and 1 PB.');
    }
  }
}

export function validatePassphrase(p: string): void {
  if (p.length < PASSPHRASE_MIN) {
    throw new OffsiteValidationError(
      `The passphrase must be at least ${PASSPHRASE_MIN} characters.`,
    );
  }
  if (p.length > PASSPHRASE_MAX) {
    throw new OffsiteValidationError(`The passphrase can be at most ${PASSPHRASE_MAX} characters.`);
  }
  if (hasControl(p)) {
    throw new OffsiteValidationError(
      'The passphrase cannot contain line breaks or other control characters.',
    );
  }
  if (p.trim() !== p) {
    throw new OffsiteValidationError(
      'The passphrase cannot start or end with a space; it is too easy to lose when you copy it.',
    );
  }
}

/**
 * Replace every occurrence of a secret in a message before it is
 * logged or stored. Errors from the S3 client do not carry the secret
 * key, but a wrong endpoint can echo request text back, so every
 * message that leaves the off-site code goes through here.
 */
export function redactSecrets(message: string, secrets: Array<string | null | undefined>): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out;
}
