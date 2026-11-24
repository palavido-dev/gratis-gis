// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';

import { OffsiteCryptoError, parsePublicKey, type OffsitePublicKey } from './offsite-crypto.js';
import { checkEndpoint, EndpointError, type EndpointPolicy } from './offsite-endpoint.js';

/**
 * Off-site backup settings: what the admin page edits, what the
 * environment can supply instead, and the checks both go through.
 *
 * Each setting is the database value when one is saved, otherwise the
 * BACKUP_OFFSITE_* environment variable. Values from either source go
 * through the same checks: a bad one is reported and treated as unset,
 * so off-site copies cannot run on it.
 *
 * The only secret is the bucket's secret access key. Off-site files
 * are encrypted to the admin's public key; the private key and its
 * passphrase are never on this server, and nothing here accepts them.
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
  publicKey: 'BACKUP_OFFSITE_PUBLIC_KEY',
  retentionDays: 'BACKUP_OFFSITE_RETENTION_DAYS',
  alertDays: 'BACKUP_OFFSITE_ALERT_DAYS',
  mirrorThresholdGb: 'BACKUP_OFFSITE_MIRROR_THRESHOLD_GB',
} as const;

export const OFFSITE_DEFAULTS = {
  region: 'us-east-1',
  /** The default folder is this plus the first 8 characters of the install id. */
  prefixBase: 'gratisgis-',
  pathStyle: true,
  retentionDays: 30,
  alertDays: 3,
  mirrorThresholdBytes: 50 * 1024 ** 3,
} as const;

export type SettingSource = 'database' | 'environment' | null;

/** Effective settings, secret included. Server side only. */
export interface OffsiteSettings {
  enabled: boolean;
  endpoint: string | null;
  endpointSource: SettingSource;
  region: string;
  bucket: string | null;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  secretSource: SettingSource;
  publicKey: OffsitePublicKey | null;
  publicKeySource: SettingSource;
  retentionDays: number;
  alertDays: number;
  mirrorThresholdBytes: number;
  installId: string | null;
  /** Values that were set but refused, in plain words. */
  problems: string[];
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
  secretAccessKeySource: SettingSource;
  publicKey: string | null;
  publicKeyFingerprint: string | null;
  publicKeySource: SettingSource;
  retentionDays: number;
  alertDays: number;
  mirrorThresholdBytes: number;
  installId: string | null;
  /** Plain http endpoints are allowed by the server environment. */
  httpAllowed: boolean;
  /** Everything needed to upload is present. */
  complete: boolean;
  /** Plain reasons it is not complete, for the page. */
  missing: string[];
  problems: string[];
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
  offsitePublicKey: string | null;
  offsiteInstallId: string | null;
  offsiteRetentionDays: number | null;
  offsiteAlertDays: number | null;
  offsiteMirrorThresholdBytes: bigint | null;
}

export type EnvReader = (name: string) => string | undefined;

function envText(env: EnvReader, name: string): string | null {
  const v = env(name)?.trim();
  return v ? v : null;
}

/** Thrown for a value the page or the environment gave that cannot be used. */
export class OffsiteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffsiteValidationError';
  }
}

/**
 * A secret from the environment: the variable itself, or the file the
 * *_FILE variable names. One trailing line break (\n or \r\n) is
 * dropped from a file, since editors add one; anything else is kept.
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

/** Drop leading and trailing slashes without a regular expression. */
export function trimSlashes(s: string, leading = true): string {
  let start = 0;
  let end = s.length;
  if (leading) while (start < end && s.charCodeAt(start) === 47) start += 1;
  while (end > start && s.charCodeAt(end - 1) === 47) end -= 1;
  return s.slice(start, end);
}

/** Empty, or ends in exactly one slash, never starts with one. */
export function normalizePrefix(p: string): string {
  const trimmed = trimSlashes(p.trim());
  return trimmed ? `${trimmed}/` : '';
}

/**
 * The one rule for a bucket folder, after normalizePrefix: parts of
 * letters A-Z and a-z, digits, ".", "_" and "-", separated by "/",
 * ending in "/", with no empty, "." or ".." parts, up to 200
 * characters. The page, the environment, offsite-cli.ts and
 * ggo_valid_prefix in infra/restore-from-offsite.sh all use it, so any
 * folder the portal writes to can be restored by the script.
 */
export const OFFSITE_PREFIX_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/;

export function isValidOffsitePrefix(p: string): boolean {
  return p.length <= 200 && OFFSITE_PREFIX_RE.test(p) && !/(^|\/)\.\.?\//.test(p);
}

export function defaultPrefix(installId: string | null): string {
  return installId
    ? `${OFFSITE_DEFAULTS.prefixBase}${installId.replace(/-/g, '').slice(0, 8)}/`
    : `${OFFSITE_DEFAULTS.prefixBase.slice(0, -1)}/`;
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

/** Each check throws a plain sentence and never repeats a secret. */
const checks = {
  bucket(v: string) {
    if (!BUCKET_RE.test(v)) {
      throw new OffsiteValidationError(
        'The bucket name can use lower-case letters, digits, dots and hyphens, 3 to 63 characters.',
      );
    }
  },
  region(v: string) {
    if (!REGION_RE.test(v)) {
      throw new OffsiteValidationError(
        "The region looks wrong. Use the provider's region name, such as us-east-1 or auto.",
      );
    }
  },
  prefix(v: string) {
    const p = normalizePrefix(v);
    // The whole bucket is not a folder: retention and the restore tool
    // both work inside one portal's folder.
    if (p === '') {
      throw new OffsiteValidationError(
        'The folder prefix cannot be empty. Give each portal its own folder, such as gratisgis-main/.',
      );
    }
    if (!isValidOffsitePrefix(p)) {
      throw new OffsiteValidationError(
        'The folder prefix can use letters A-Z and a-z, digits 0-9, dots, underscores and hyphens, with "/" between folders, up to 200 characters, and no "." or ".." folders.',
      );
    }
  },
  accessKeyId(v: string) {
    if (!ACCESS_KEY_RE.test(v)) {
      throw new OffsiteValidationError('The access key id has characters that are not allowed.');
    }
  },
  secretAccessKey(v: string) {
    if (v.length > 512 || hasControl(v, true)) {
      throw new OffsiteValidationError(
        'The secret access key has spaces or characters that are not allowed.',
      );
    }
  },
  endpoint(v: string, policy: EndpointPolicy): string {
    try {
      return checkEndpoint(v, policy);
    } catch (e) {
      if (e instanceof EndpointError) throw new OffsiteValidationError(e.message);
      throw e;
    }
  },
  publicKey(v: string): OffsitePublicKey {
    try {
      return parsePublicKey(v);
    } catch (e) {
      if (e instanceof OffsiteCryptoError) throw new OffsiteValidationError(e.message);
      throw new OffsiteValidationError('The public key could not be read.');
    }
  },
  int(name: string, v: number, lo: number, hi: number) {
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new OffsiteValidationError(`${name} must be a whole number from ${lo} to ${hi}.`);
    }
  },
  mirrorThreshold(v: number) {
    if (!Number.isSafeInteger(v) || v < 1024 ** 3 || v > 1024 ** 5) {
      throw new OffsiteValidationError('The mirror threshold must be between 1 GB and 1 PB.');
    }
  },
};

const LIMITS = {
  retentionDays: ['Days to keep off-site copies', 1, 3650],
  alertDays: ['Days before a missing off-site copy is reported', 1, 90],
} as const;

/**
 * Merge the saved row over the environment, checking every value
 * whatever its source. A refused value becomes unset and is named in
 * `problems`, so the copy is not attempted with it.
 */
export function resolveOffsiteSettings(
  row: OffsiteRow,
  secrets: {
    secretFromDb: string | null;
    /** A secret is saved but does not open: never fall back to the environment's. */
    storedSecretUnreadable?: boolean;
  },
  env: EnvReader,
  policy: EndpointPolicy,
  readFile?: (p: string) => string,
): OffsiteSettings {
  const problems: string[] = [];
  const pick = <I, O>(
    label: string,
    dbValue: I | null,
    envValue: I | null,
    check: (v: I) => O,
  ): { value: O | null; source: SettingSource } => {
    const source: SettingSource =
      dbValue !== null ? 'database' : envValue !== null ? 'environment' : null;
    const value = dbValue ?? envValue;
    if (value === null) return { value: null, source: null };
    try {
      return { value: check(value), source };
    } catch (e) {
      const where =
        source === 'environment' ? `the ${label} environment variable` : `the saved ${label}`;
      problems.push(`${e instanceof Error ? e.message : 'Not usable.'} (from ${where})`);
      return { value: null, source: null };
    }
  };
  const same =
    (fn: (v: string) => void) =>
    (v: string): string => {
      fn(v);
      return v;
    };
  const envBool = (name: string): boolean | null => {
    const v = envText(env, name)?.toLowerCase();
    if (v === undefined || v === null) return null;
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    problems.push(`${name} must be true or false.`);
    return null;
  };
  const envInt = (name: string): number | null => {
    const v = envText(env, name);
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) {
      problems.push(`${name} must be a whole number.`);
      return null;
    }
    return n;
  };
  const intIn =
    (lim: readonly [string, number, number]) =>
    (v: number): number => {
      checks.int(lim[0], v, lim[1], lim[2]);
      return v;
    };

  const endpoint = pick(
    'endpoint',
    row.offsiteEndpoint,
    envText(env, OFFSITE_ENV.endpoint),
    (v: string) => checks.endpoint(v, policy),
  );
  const region = pick(
    'region',
    row.offsiteRegion,
    envText(env, OFFSITE_ENV.region),
    same(checks.region),
  );
  const bucket = pick(
    'bucket',
    row.offsiteBucket,
    envText(env, OFFSITE_ENV.bucket),
    same(checks.bucket),
  );
  const prefix = pick(
    'prefix',
    row.offsitePrefix,
    envText(env, OFFSITE_ENV.prefix),
    same(checks.prefix),
  );
  const keyId = pick(
    'access key id',
    row.offsiteAccessKeyId,
    envText(env, OFFSITE_ENV.accessKeyId),
    same(checks.accessKeyId),
  );
  let secret = pick(
    'secret access key',
    secrets.secretFromDb,
    secrets.storedSecretUnreadable
      ? null
      : envSecret(env, OFFSITE_ENV.secretAccessKey, OFFSITE_ENV.secretAccessKeyFile, readFile),
    same(checks.secretAccessKey),
  );
  // The environment's secret goes only with the environment's endpoint
  // and key id, when those are set there: a value saved on the page
  // cannot take it elsewhere.
  if (secret.source === 'environment') {
    const envEndpoint = envText(env, OFFSITE_ENV.endpoint);
    const envKeyId = envText(env, OFFSITE_ENV.accessKeyId);
    const endpointMoved =
      envEndpoint !== null &&
      endpoint.source === 'database' &&
      endpoint.value !== safeEndpoint(envEndpoint, policy);
    const keyMoved = envKeyId !== null && keyId.source === 'database' && keyId.value !== envKeyId;
    if (endpointMoved || keyMoved) {
      problems.push(
        'The secret access key from the server environment is used only with the endpoint and access key id from the environment. Type the secret for this endpoint on the page, or clear the endpoint and access key id saved on the page.',
      );
      secret = { value: null, source: null };
    }
  }
  const publicKey = pick(
    'public key',
    row.offsitePublicKey,
    envText(env, OFFSITE_ENV.publicKey),
    checks.publicKey,
  );
  const ret = pick(
    'retention days',
    row.offsiteRetentionDays,
    envInt(OFFSITE_ENV.retentionDays),
    intIn(LIMITS.retentionDays),
  );
  const alert = pick(
    'alert days',
    row.offsiteAlertDays,
    envInt(OFFSITE_ENV.alertDays),
    intIn(LIMITS.alertDays),
  );
  const gb = envInt(OFFSITE_ENV.mirrorThresholdGb);
  const threshold = pick(
    'mirror threshold',
    row.offsiteMirrorThresholdBytes === null ? null : Number(row.offsiteMirrorThresholdBytes),
    gb === null ? null : gb * 1024 ** 3,
    (v: number) => {
      checks.mirrorThreshold(v);
      return v;
    },
  );
  const enabledEnv = envBool(OFFSITE_ENV.enabled);
  const pathStyleEnv = envBool(OFFSITE_ENV.pathStyle);

  return {
    enabled: row.offsiteEnabled ?? enabledEnv ?? false,
    endpoint: endpoint.value,
    endpointSource: endpoint.source,
    region: region.value ?? OFFSITE_DEFAULTS.region,
    bucket: bucket.value,
    prefix: normalizePrefix(prefix.value ?? defaultPrefix(row.offsiteInstallId)),
    pathStyle: row.offsitePathStyle ?? pathStyleEnv ?? OFFSITE_DEFAULTS.pathStyle,
    accessKeyId: keyId.value,
    secretAccessKey: secret.value,
    secretSource: secret.source,
    publicKey: publicKey.value,
    publicKeySource: publicKey.source,
    retentionDays: ret.value ?? OFFSITE_DEFAULTS.retentionDays,
    alertDays: alert.value ?? OFFSITE_DEFAULTS.alertDays,
    mirrorThresholdBytes: threshold.value ?? OFFSITE_DEFAULTS.mirrorThresholdBytes,
    installId: row.offsiteInstallId,
    problems,
  };
}

function safeEndpoint(v: string, policy: EndpointPolicy): string | null {
  try {
    return checkEndpoint(v, policy);
  } catch {
    return null;
  }
}

export function missingSettings(s: OffsiteSettings): string[] {
  const out: string[] = [];
  if (!s.endpoint) out.push('endpoint');
  if (!s.bucket) out.push('bucket');
  if (!s.accessKeyId) out.push('accessKeyId');
  if (!s.secretAccessKey) out.push('secretAccessKey');
  if (!s.publicKey) out.push('publicKey');
  return out;
}

export function toPublicConfig(s: OffsiteSettings, policy: EndpointPolicy): OffsitePublicConfig {
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
    publicKey: s.publicKey?.text ?? null,
    publicKeyFingerprint: s.publicKey?.fingerprintText ?? null,
    publicKeySource: s.publicKeySource,
    retentionDays: s.retentionDays,
    alertDays: s.alertDays,
    mirrorThresholdBytes: s.mirrorThresholdBytes,
    installId: s.installId,
    httpAllowed: policy.allowHttp,
    complete: missing.length === 0 && s.problems.length === 0,
    missing,
    problems: s.problems,
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
  /** The admin's public key, text form. Null clears the saved one. */
  publicKey?: string | null;
  retentionDays?: number | null;
  alertDays?: number | null;
  mirrorThresholdBytes?: number | null;
}

/** Names a patch may never carry: the server takes no private key material. */
const FORBIDDEN_FIELDS = ['passphrase', 'passphraseConfirm', 'privateKey', 'keyFile'];

/**
 * Check a patch before anything is written. Throws a plain sentence
 * the page can show; never includes a secret value in the message.
 */
export function validateOffsitePatch(patch: OffsitePatch, policy: EndpointPolicy): void {
  for (const f of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) {
      throw new OffsiteValidationError(
        'The portal never takes the private key or its passphrase. Paste only the public key.',
      );
    }
  }
  const str = (v: string | null | undefined) =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const e = str(patch.endpoint);
  if (e) checks.endpoint(e, policy);
  const b = str(patch.bucket);
  if (b) checks.bucket(b);
  const r = str(patch.region);
  if (r) checks.region(r);
  if (typeof patch.prefix === 'string') checks.prefix(patch.prefix);
  const k = str(patch.accessKeyId);
  if (k) checks.accessKeyId(k);
  if (typeof patch.secretAccessKey === 'string' && patch.secretAccessKey.length > 0) {
    checks.secretAccessKey(patch.secretAccessKey);
  }
  const pk = str(patch.publicKey);
  if (pk) checks.publicKey(pk);
  if (patch.retentionDays !== undefined && patch.retentionDays !== null) {
    checks.int(
      LIMITS.retentionDays[0],
      patch.retentionDays,
      LIMITS.retentionDays[1],
      LIMITS.retentionDays[2],
    );
  }
  if (patch.alertDays !== undefined && patch.alertDays !== null) {
    checks.int(LIMITS.alertDays[0], patch.alertDays, LIMITS.alertDays[1], LIMITS.alertDays[2]);
  }
  if (patch.mirrorThresholdBytes !== undefined && patch.mirrorThresholdBytes !== null) {
    checks.mirrorThreshold(patch.mirrorThresholdBytes);
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
