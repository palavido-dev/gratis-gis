// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  envSecret,
  normalizePrefix,
  OFFSITE_DEFAULTS,
  redactSecrets,
  resolveOffsiteSettings,
  toPublicConfig,
  validateOffsitePatch,
  type OffsiteRow,
} from './offsite-config.js';

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

const env = (vars: Record<string, string>) => (name: string) => vars[name];
const noSecrets = { secretFromDb: null, passphraseFromDb: null };

describe('off-site settings', () => {
  it('uses defaults when nothing is set, and is off', () => {
    const s = resolveOffsiteSettings(EMPTY_ROW, noSecrets, env({}));
    expect(s.enabled).toBe(false);
    expect(s.region).toBe('us-east-1');
    expect(s.prefix).toBe('gratisgis/');
    expect(s.retentionDays).toBe(OFFSITE_DEFAULTS.retentionDays);
    expect(toPublicConfig(s).missing).toEqual([
      'endpoint',
      'bucket',
      'accessKeyId',
      'secretAccessKey',
      'passphrase',
    ]);
  });

  it('reads every setting from the environment', () => {
    const s = resolveOffsiteSettings(
      EMPTY_ROW,
      noSecrets,
      env({
        BACKUP_OFFSITE_ENABLED: 'true',
        BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.com',
        BACKUP_OFFSITE_REGION: 'auto',
        BACKUP_OFFSITE_BUCKET: 'my-backups',
        BACKUP_OFFSITE_PREFIX: '/site-a',
        BACKUP_OFFSITE_PATH_STYLE: 'false',
        BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
        BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'env-secret-value',
        BACKUP_OFFSITE_PASSPHRASE: 'an env passphrase long enough',
        BACKUP_OFFSITE_RETENTION_DAYS: '90',
        BACKUP_OFFSITE_ALERT_DAYS: '5',
        BACKUP_OFFSITE_MIRROR_THRESHOLD_GB: '2',
      }),
    );
    expect(s).toMatchObject({
      enabled: true,
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'my-backups',
      prefix: 'site-a/',
      pathStyle: false,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'env-secret-value',
      secretSource: 'environment',
      passphraseSource: 'environment',
      retentionDays: 90,
      alertDays: 5,
      mirrorThresholdBytes: 2 * 1024 ** 3,
    });
  });

  it('prefers saved values over the environment', () => {
    const s = resolveOffsiteSettings(
      { ...EMPTY_ROW, offsiteBucket: 'saved', offsiteEnabled: false },
      { secretFromDb: 'db-secret', passphraseFromDb: null },
      env({
        BACKUP_OFFSITE_BUCKET: 'from-env',
        BACKUP_OFFSITE_ENABLED: 'true',
        BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'env',
      }),
    );
    expect(s.bucket).toBe('saved');
    expect(s.enabled).toBe(false);
    expect(s.secretAccessKey).toBe('db-secret');
    expect(s.secretSource).toBe('database');
  });

  it('reads a secret from a *_FILE path and drops one trailing newline', () => {
    const read = (p: string) => {
      if (p === '/run/secrets/pass') return 'file passphrase value\n';
      throw new Error('ENOENT');
    };
    expect(
      envSecret(
        env({ BACKUP_OFFSITE_PASSPHRASE_FILE: '/run/secrets/pass' }),
        'BACKUP_OFFSITE_PASSPHRASE',
        'BACKUP_OFFSITE_PASSPHRASE_FILE',
        read,
      ),
    ).toBe('file passphrase value');
    expect(
      envSecret(
        env({ BACKUP_OFFSITE_PASSPHRASE_FILE: '/missing' }),
        'BACKUP_OFFSITE_PASSPHRASE',
        'BACKUP_OFFSITE_PASSPHRASE_FILE',
        read,
      ),
    ).toBeNull();
  });

  it('the public view carries no secret values', () => {
    const s = resolveOffsiteSettings(
      {
        ...EMPTY_ROW,
        offsiteEndpoint: 'https://e.example',
        offsiteBucket: 'b-1',
        offsiteAccessKeyId: 'AKID',
      },
      { secretFromDb: 'TOP-SECRET-KEY-123', passphraseFromDb: 'TOP SECRET PASSPHRASE 456' },
      env({}),
    );
    const view = toPublicConfig(s);
    const json = JSON.stringify(view);
    expect(json).not.toContain('TOP-SECRET-KEY-123');
    expect(json).not.toContain('TOP SECRET PASSPHRASE 456');
    expect(view.hasSecretAccessKey).toBe(true);
    expect(view.hasPassphrase).toBe(true);
    expect(view.complete).toBe(true);
    expect(Object.keys(view)).not.toEqual(
      expect.arrayContaining(['secretAccessKey', 'passphrase']),
    );
  });

  it.each([
    ['', ''],
    ['/', ''],
    ['backups', 'backups/'],
    ['/a/b//', 'a/b/'],
  ])('normalizes prefix %j to %j', (input, out) => {
    expect(normalizePrefix(input)).toBe(out);
  });
});

describe('validateOffsitePatch', () => {
  const ok = { allowHttp: false };
  it.each([
    [{ endpoint: 'not a url' }, /full URL/],
    [{ endpoint: 'http://minio:9000' }, /https/],
    [{ endpoint: 'https://user:pw@s3.example.com' }, /own fields/],
    [{ endpoint: 'https://s3.example.com/bucket' }, /without a path/],
    [{ bucket: 'Bad_Bucket' }, /bucket name/],
    [{ region: 'us east' }, /region/],
    [{ prefix: 'a/../b' }, /prefix/],
    [{ accessKeyId: 'has space' }, /access key id/],
    [{ secretAccessKey: 'has space' }, /secret access key/],
    [{ passphrase: 'short', passphraseConfirm: 'short' }, /at least 16/],
    [
      { passphrase: ' leading space passphrase', passphraseConfirm: ' leading space passphrase' },
      /start or end/,
    ],
    [
      { passphrase: 'line\nbreak passphrase!!', passphraseConfirm: 'line\nbreak passphrase!!' },
      /line breaks/,
    ],
    [
      { passphrase: 'a long enough passphrase', passphraseConfirm: 'a different one entirely' },
      /do not match/,
    ],
    [{ retentionDays: 0 }, /from 1 to 3650/],
    [{ alertDays: 91 }, /from 1 to 90/],
    [{ mirrorThresholdBytes: 1000 }, /1 GB/],
  ])('refuses %j', (patch, msg) => {
    expect(() => validateOffsitePatch(patch, ok)).toThrow(msg);
  });

  it('never puts a secret in a refusal message', () => {
    const secret = 'sneaky secret with spaces';
    try {
      validateOffsitePatch({ secretAccessKey: secret }, ok);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('accepts a complete, sensible patch', () => {
    expect(() =>
      validateOffsitePatch(
        {
          enabled: true,
          endpoint: 'https://s3.eu-central-003.backblazeb2.com',
          region: 'eu-central-003',
          bucket: 'acme.backups-1',
          prefix: 'portal/',
          accessKeyId: '003abc',
          secretAccessKey: 'K003secretsecret',
          passphrase: 'a long enough passphrase',
          passphraseConfirm: 'a long enough passphrase',
          retentionDays: 30,
          alertDays: 3,
          mirrorThresholdBytes: 50 * 1024 ** 3,
        },
        ok,
      ),
    ).not.toThrow();
  });

  it('allows http only when the operator says so', () => {
    expect(() =>
      validateOffsitePatch({ endpoint: 'http://minio:9000' }, { allowHttp: true }),
    ).not.toThrow();
  });
});

describe('redactSecrets', () => {
  it('removes every occurrence of each secret', () => {
    expect(redactSecrets('a SECRETX b SECRETX c PASSY', ['SECRETX', 'PASSY', null])).toBe(
      'a [redacted] b [redacted] c [redacted]',
    );
  });
});
