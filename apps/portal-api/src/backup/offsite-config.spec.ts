// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultPrefix,
  envSecret,
  normalizePrefix,
  OFFSITE_DEFAULTS,
  redactSecrets,
  resolveOffsiteSettings,
  toPublicConfig,
  validateOffsitePatch,
  type OffsitePatch,
  type OffsiteRow,
} from './offsite-config.js';
import { generateOffsiteKeyPair } from './offsite-crypto.js';
import {
  assertEndpointReachable,
  checkEndpoint,
  endpointPolicy,
  guardedLookup,
  isRefusedAddress,
} from './offsite-endpoint.js';
import { createOffsiteClient, OFFSITE_TIMEOUTS, requestTimeoutFor } from './offsite-store.js';

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

const env = (vars: Record<string, string>) => (name: string) => vars[name];
const noSecret = { secretFromDb: null };
const strict = { allowHttp: false, allowLocal: false };
const PUB = generateOffsiteKeyPair().publicKey;

describe('off-site settings', () => {
  it('uses defaults when nothing is set, and is off', () => {
    const s = resolveOffsiteSettings(EMPTY_ROW, noSecret, env({}), strict);
    expect(s.enabled).toBe(false);
    expect(s.region).toBe('us-east-1');
    expect(s.retentionDays).toBe(OFFSITE_DEFAULTS.retentionDays);
    expect(s.mirrorThresholdBytes).toBe(50 * 1024 ** 3);
    expect(toPublicConfig(s, strict).missing).toEqual([
      'endpoint',
      'bucket',
      'accessKeyId',
      'secretAccessKey',
      'publicKey',
    ]);
  });

  it('the default folder is different for every install', () => {
    const a = resolveOffsiteSettings(
      { ...EMPTY_ROW, offsiteInstallId: '0f1e2d3c-aaaa-4bbb-8ccc-000000000001' },
      noSecret,
      env({}),
      strict,
    );
    const b = resolveOffsiteSettings(
      { ...EMPTY_ROW, offsiteInstallId: '9a8b7c6d-aaaa-4bbb-8ccc-000000000002' },
      noSecret,
      env({}),
      strict,
    );
    expect(a.prefix).toBe('gratisgis-0f1e2d3c/');
    expect(b.prefix).toBe('gratisgis-9a8b7c6d/');
    expect(defaultPrefix(null)).toBe('gratisgis/');
  });

  it('reads every setting from the environment', () => {
    const s = resolveOffsiteSettings(
      EMPTY_ROW,
      noSecret,
      env({
        BACKUP_OFFSITE_ENABLED: 'true',
        BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.com',
        BACKUP_OFFSITE_REGION: 'auto',
        BACKUP_OFFSITE_BUCKET: 'my-backups',
        BACKUP_OFFSITE_PREFIX: '/site-a',
        BACKUP_OFFSITE_PATH_STYLE: 'false',
        BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
        BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'env-secret-value',
        BACKUP_OFFSITE_PUBLIC_KEY: PUB.text,
        BACKUP_OFFSITE_RETENTION_DAYS: '90',
        BACKUP_OFFSITE_ALERT_DAYS: '5',
        BACKUP_OFFSITE_MIRROR_THRESHOLD_GB: '2',
      }),
      strict,
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
      publicKeySource: 'environment',
      retentionDays: 90,
      alertDays: 5,
      mirrorThresholdBytes: 2 * 1024 ** 3,
      problems: [],
    });
    expect(s.publicKey?.fingerprintText).toBe(PUB.fingerprintText);
  });

  it('checks values from the environment like values from the page', () => {
    const s = resolveOffsiteSettings(
      EMPTY_ROW,
      noSecret,
      env({
        BACKUP_OFFSITE_ENDPOINT: 'http://store.example.com',
        BACKUP_OFFSITE_BUCKET: 'Bad_Bucket',
        BACKUP_OFFSITE_PUBLIC_KEY: 'ggpub1:not-a-key',
        BACKUP_OFFSITE_RETENTION_DAYS: '0',
        BACKUP_OFFSITE_ENABLED: 'maybe',
        BACKUP_OFFSITE_MIRROR_THRESHOLD_GB: 'lots',
      }),
      strict,
    );
    expect(s.endpoint).toBeNull();
    expect(s.bucket).toBeNull();
    expect(s.publicKey).toBeNull();
    expect(s.retentionDays).toBe(30);
    expect(s.problems.join(' ')).toMatch(/must use https/);
    expect(s.problems.join(' ')).toMatch(/bucket name/);
    expect(s.problems.join(' ')).toMatch(/public key is the wrong length/);
    expect(s.problems.join(' ')).toMatch(/from 1 to 3650/);
    expect(s.problems.join(' ')).toMatch(/BACKUP_OFFSITE_ENABLED must be true or false/);
    expect(s.problems.join(' ')).toMatch(
      /BACKUP_OFFSITE_MIRROR_THRESHOLD_GB must be a whole number/,
    );
    expect(toPublicConfig(s, strict).complete).toBe(false);
  });

  it('an http endpoint needs the server flag, from the page or the environment', () => {
    for (const row of [{ ...EMPTY_ROW, offsiteEndpoint: 'http://minio.lan:9000' }, EMPTY_ROW]) {
      const vars = { BACKUP_OFFSITE_ENDPOINT: 'http://minio.lan:9000' };
      expect(resolveOffsiteSettings(row, noSecret, env(vars), strict).endpoint).toBeNull();
      expect(
        resolveOffsiteSettings(row, noSecret, env(vars), { allowHttp: true, allowLocal: false })
          .endpoint,
      ).toBe('http://minio.lan:9000');
    }
  });

  it('prefers saved values over the environment', () => {
    const s = resolveOffsiteSettings(
      { ...EMPTY_ROW, offsiteBucket: 'saved', offsiteEnabled: false },
      { secretFromDb: 'db-secret' },
      env({
        BACKUP_OFFSITE_BUCKET: 'from-env',
        BACKUP_OFFSITE_ENABLED: 'true',
        BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'env',
      }),
      strict,
    );
    expect(s.bucket).toBe('saved');
    expect(s.enabled).toBe(false);
    expect(s.secretAccessKey).toBe('db-secret');
    expect(s.secretSource).toBe('database');
  });

  it('reads a secret from a *_FILE path and drops one trailing LF or CRLF', () => {
    const read = (p: string) => {
      if (p === '/run/secrets/a') return 'file secret value\n';
      if (p === '/run/secrets/b') return 'file secret value\r\n';
      throw new Error('ENOENT');
    };
    for (const f of ['/run/secrets/a', '/run/secrets/b']) {
      expect(
        envSecret(
          env({ BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE: f }),
          'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
          'BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE',
          read,
        ),
      ).toBe('file secret value');
    }
    expect(
      envSecret(
        env({ BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE: '/missing' }),
        'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
        'BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE',
        read,
      ),
    ).toBeNull();
  });

  it('the public view carries no secret, and shows the key with its fingerprint', () => {
    const s = resolveOffsiteSettings(
      {
        ...EMPTY_ROW,
        offsiteEndpoint: 'https://e.example',
        offsiteBucket: 'b-1',
        offsiteAccessKeyId: 'AKID',
        offsitePublicKey: PUB.text,
      },
      { secretFromDb: 'TOP-SECRET-KEY-123' },
      env({}),
      strict,
    );
    const view = toPublicConfig(s, strict);
    expect(JSON.stringify(view)).not.toContain('TOP-SECRET-KEY-123');
    expect(view.hasSecretAccessKey).toBe(true);
    expect(view.publicKey).toBe(PUB.text);
    expect(view.publicKeyFingerprint).toBe(PUB.fingerprintText);
    expect(view.complete).toBe(true);
    expect(Object.keys(view)).not.toContain('secretAccessKey');
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

describe('the folder prefix is never the whole bucket', () => {
  it('refuses an empty prefix from the environment or the saved row', () => {
    for (const [row, vars] of [
      [EMPTY_ROW, { BACKUP_OFFSITE_PREFIX: '/' }],
      [{ ...EMPTY_ROW, offsitePrefix: '' }, {}],
    ] as const) {
      const s = resolveOffsiteSettings(row, noSecret, env(vars), strict);
      expect(s.problems.join(' ')).toMatch(/cannot be empty/);
      expect(s.prefix).not.toBe('');
      expect(toPublicConfig(s, strict).complete).toBe(false);
    }
  });
});

describe('the secret from the environment stays with the endpoint from the environment', () => {
  const vars = {
    BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
    BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKENV',
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'env-secret-value-1',
  };
  it('is used with the environment endpoint, or a saved one that is the same', () => {
    expect(resolveOffsiteSettings(EMPTY_ROW, noSecret, env(vars), strict).secretAccessKey).toBe(
      'env-secret-value-1',
    );
    const same = resolveOffsiteSettings(
      { ...EMPTY_ROW, offsiteEndpoint: 'https://s3.example.test/' },
      noSecret,
      env(vars),
      strict,
    );
    expect(same.secretAccessKey).toBe('env-secret-value-1');
  });

  it('is not used with an endpoint or key id saved on the page', () => {
    for (const row of [
      { ...EMPTY_ROW, offsiteEndpoint: 'https://elsewhere.example.test' },
      { ...EMPTY_ROW, offsiteAccessKeyId: 'AKOTHER' },
    ]) {
      const s = resolveOffsiteSettings(row, noSecret, env(vars), strict);
      expect(s.secretAccessKey).toBeNull();
      expect(s.problems.join(' ')).toMatch(/only with the endpoint and access key id/);
    }
  });

  it('is not used when a saved secret is there but does not open', () => {
    const s = resolveOffsiteSettings(
      EMPTY_ROW,
      { secretFromDb: null, storedSecretUnreadable: true },
      env(vars),
      strict,
    );
    expect(s.secretAccessKey).toBeNull();
  });
});

describe('validateOffsitePatch', () => {
  it.each<[OffsitePatch, RegExp]>([
    [{ endpoint: 'not a url' }, /full URL/],
    [{ endpoint: 'http://minio:9000' }, /https/],
    [{ endpoint: 'https://user:pw@s3.example.com' }, /own fields/],
    [{ endpoint: 'https://s3.example.com/bucket' }, /without a path/],
    [{ bucket: 'Bad_Bucket' }, /bucket name/],
    [{ region: 'us east' }, /region/],
    [{ prefix: 'a/../b' }, /prefix/],
    [{ prefix: '' }, /cannot be empty/],
    [{ prefix: '/' }, /cannot be empty/],
    [{ prefix: ' // ' }, /cannot be empty/],
    [{ accessKeyId: 'has space' }, /access key id/],
    [{ secretAccessKey: 'has space' }, /secret access key/],
    [{ publicKey: 'ggpub1:short' }, /wrong length/],
    [{ retentionDays: 0 }, /from 1 to 3650/],
    [{ alertDays: 91 }, /from 1 to 90/],
    [{ mirrorThresholdBytes: 1000 }, /1 GB/],
  ])('refuses %j', (patch, msg) => {
    expect(() => validateOffsitePatch(patch, strict)).toThrow(msg);
  });

  it('never takes a passphrase or private key, and never repeats one', () => {
    for (const patch of [
      { passphrase: 'a long enough passphrase' },
      { passphraseConfirm: 'x' },
      { privateKey: 'ggsec1:abc' },
    ]) {
      expect(() => validateOffsitePatch(patch as OffsitePatch, strict)).toThrow(
        /never takes the private key/,
      );
    }
    try {
      validateOffsitePatch({ publicKey: 'ggsec1:SECRETSECRETSECRET' }, strict);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).toMatch(/private key/);
      expect((e as Error).message).not.toContain('SECRETSECRET');
    }
  });

  it('never puts a secret in a refusal message', () => {
    const secret = 'sneaky secret with spaces';
    try {
      validateOffsitePatch({ secretAccessKey: secret }, strict);
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
          publicKey: PUB.text,
          retentionDays: 30,
          alertDays: 3,
          mirrorThresholdBytes: 50 * 1024 ** 3,
        },
        strict,
      ),
    ).not.toThrow();
  });
});

describe('endpoint rules', () => {
  it('allows http only when the server environment says so', () => {
    expect(() => checkEndpoint('http://minio.lan:9000', strict)).toThrow(/https/);
    expect(checkEndpoint('http://minio.lan:9000', { allowHttp: true, allowLocal: false })).toBe(
      'http://minio.lan:9000',
    );
    expect(endpointPolicy(env({ BACKUP_OFFSITE_ALLOW_HTTP: 'true' })).allowHttp).toBe(true);
    expect(endpointPolicy(env({})).allowHttp).toBe(false);
  });

  it.each([
    'https://localhost:9000',
    'https://api.localhost',
    'https://127.0.0.1',
    'https://127.8.9.10:443',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://[::7f00:1]',
    'https://[::127.0.0.1]',
    'https://[64:ff9b::7f00:1]',
    'https://[64:ff9b::169.254.169.254]',
    'https://[64:ff9b:1::a9fe:a9fe]',
    'https://169.254.169.254',
    'https://[fe80::1]',
    'https://[fd00:ec2::254]',
    'https://100.100.100.200',
    'https://metadata.google.internal',
    'https://instance-data.ec2.internal.',
  ])('refuses %s unless the local flag is set', (url) => {
    expect(() => checkEndpoint(url, strict)).toThrow(/this server|link-local|metadata/);
    expect(() => checkEndpoint(url, { allowHttp: false, allowLocal: true })).not.toThrow();
  });

  it('allows a private network address and public names', () => {
    for (const url of [
      'https://10.0.0.5:9000',
      'https://192.168.1.20',
      'https://s3.amazonaws.com',
    ]) {
      expect(() => checkEndpoint(url, strict)).not.toThrow();
    }
    expect(isRefusedAddress('8.8.8.8')).toBe(false);
  });
});

describe('endpoint rules after DNS', () => {
  it('refuses a name that resolves to this server or a metadata address', async () => {
    const lookup = (answers: string[]) => async () => answers.map((address) => ({ address }));
    await expect(
      assertEndpointReachable('https://store.example.com', strict, lookup(['127.0.0.1'])),
    ).rejects.toThrow(/points at this server/);
    await expect(
      assertEndpointReachable(
        'https://store.example.com',
        strict,
        lookup(['203.0.113.5', '169.254.169.254']),
      ),
    ).rejects.toThrow(/points at/);
    await expect(
      assertEndpointReachable('https://store.example.com', strict, lookup(['203.0.113.5'])),
    ).resolves.toBeUndefined();
    await expect(
      assertEndpointReachable(
        'https://store.example.com',
        { allowHttp: false, allowLocal: true },
        lookup(['127.0.0.1']),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('the connection itself checks every address it is given', () => {
  type Cb = (err: Error | null, address: unknown, family?: number) => void;
  const fakeDns =
    (answer: string | Array<{ address: string; family: number }>) =>
    (_h: string, _o: unknown, cb: Cb) =>
      cb(null, answer, typeof answer === 'string' ? 4 : undefined);
  const run = (
    policy: { allowHttp: boolean; allowLocal: boolean },
    answer: string | Array<{ address: string; family: number }>,
    all = false,
  ) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) =>
      guardedLookup(policy, fakeDns(answer) as never)(
        'store.example.com',
        { all },
        (err, address) => resolve({ err, address }),
      ),
    );

  it('refuses an answer that turned into a refused address after the first check', async () => {
    expect((await run(strict, '127.0.0.1')).err?.message).toMatch(/points at this server/);
    const many = await run(
      strict,
      [
        { address: '203.0.113.5', family: 4 },
        { address: '::ffff:169.254.169.254', family: 6 },
      ],
      true,
    );
    expect(many.err?.message).toMatch(/points at/);
  });

  it('passes a good answer through unchanged, in both forms', async () => {
    expect(await run(strict, '203.0.113.5')).toEqual({ err: null, address: '203.0.113.5' });
    const list = [{ address: '2001:db8::5', family: 6 }];
    expect(await run(strict, list, true)).toEqual({ err: null, address: list });
    expect((await run({ allowHttp: false, allowLocal: true }, '127.0.0.1')).err).toBeNull();
  });
});

describe('S3 client limits', () => {
  it('sets connection, idle and request limits, and makes requests fail when one is reached', async () => {
    const client = createOffsiteClient(
      {
        region: 'us-east-1',
        endpoint: 'https://s3.example.test',
        pathStyle: true,
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      } as never,
      strict,
    );
    const handler = client.config.requestHandler as unknown as {
      configProvider: Promise<Record<string, unknown>>;
    };
    const cfg = await handler.configProvider;
    expect(cfg.connectionTimeout).toBe(OFFSITE_TIMEOUTS.connectMs);
    expect(cfg.socketTimeout).toBe(OFFSITE_TIMEOUTS.idleMs);
    expect(cfg.requestTimeout).toBe(OFFSITE_TIMEOUTS.requestMs);
    expect(cfg.throwOnRequestTimeout).toBe(true);
    client.destroy();
  });

  it('a provider that accepts the connection and never answers is given up on', async () => {
    const { createServer } = await import('node:http');
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const sockets: Array<{ destroy: () => void }> = [];
    const server = createServer(() => undefined);
    server.on('connection', (c) => sockets.push(c));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const client = createOffsiteClient(
      {
        region: 'us-east-1',
        endpoint: `http://127.0.0.1:${port}`,
        pathStyle: true,
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      } as never,
      { allowHttp: true, allowLocal: true },
      { connectMs: 1000, idleMs: 60_000, requestMs: 300 },
    );
    const started = Date.now();
    try {
      await expect(
        client.send(new ListObjectsV2Command({ Bucket: 'b' }), { requestTimeout: 300 } as never),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      client.destroy();
      for (const c of sockets) c.destroy();
      await new Promise((r) => server.close(r));
    }
  });

  it('gives a bigger part more time, never less than the default', () => {
    expect(requestTimeoutFor(1024)).toBe(OFFSITE_TIMEOUTS.requestMs);
    expect(requestTimeoutFor(1024 ** 3)).toBeGreaterThan(OFFSITE_TIMEOUTS.requestMs);
  });
});

describe('redactSecrets', () => {
  it('removes every occurrence of each secret', () => {
    expect(redactSecrets('a SECRETX b SECRETX c PASSY', ['SECRETX', 'PASSY', null])).toBe(
      'a [redacted] b [redacted] c [redacted]',
    );
  });
});
