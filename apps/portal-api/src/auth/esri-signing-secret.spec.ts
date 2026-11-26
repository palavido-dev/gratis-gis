// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import { deriveServerSigningKey } from '../storage/signing-key.js';
import {
  PLACEHOLDER_SECRETS,
  checkEsriSigningSecret,
  esriSigningSecret,
} from './esri-signing-secret.js';
import { ESRI_TOKEN_KEY_LABEL, signEsriToken } from './esri-token.js';
import { EsriTokenService } from './esri-token.service.js';

const REAL = 'k3P9vQz2Lr8XwYt6NbHc4JmD7sFa1GeU';
const MINIO = 'Zx7Qp2Wm9Rt4Ys6Vb1Nc8Kd3Lf5Hg0Ja';

function service(env: Record<string, string | undefined>): EsriTokenService {
  const cfg = { get: (name: string) => env[name] } as unknown as ConfigService;
  const prisma = {
    user: {
      findUnique: async () => ({ deletedAt: null, disabledAt: null, autoDisableAt: null, orgRole: 'admin' }),
    },
  };
  const authSync = { principalForUserId: async (id: string) => ({ id, username: 'admin' }) };
  return new EsriTokenService(prisma as never, {} as never, authSync as never, cfg);
}

function tokenSignedWith(secret: string): string {
  const key = deriveServerSigningKey(secret, ESRI_TOKEN_KEY_LABEL);
  return signEsriToken({ uid: 'u1', exp: Date.now() + 60_000 }, key);
}

describe('Esri token signing secret', () => {
  it('uses GRATIS_SIGNING_SECRET when it is set', () => {
    expect(esriSigningSecret({ GRATIS_SIGNING_SECRET: REAL, MINIO_SECRET_KEY: MINIO })).toEqual({
      secret: REAL,
      dedicated: true,
    });
  });

  it('falls back to the MinIO secret when it is unset or empty', () => {
    expect(esriSigningSecret({ MINIO_SECRET_KEY: MINIO })).toEqual({ secret: MINIO, dedicated: false });
    expect(esriSigningSecret({ GRATIS_SIGNING_SECRET: '', MINIO_SECRET_KEY: MINIO })).toEqual({
      secret: MINIO,
      dedicated: false,
    });
    expect(esriSigningSecret({ GRATIS_SIGNING_SECRET: '  ', MINIO_SECRET_KEY: MINIO }).dedicated).toBe(false);
  });

  it('keeps the old development default when nothing is set', () => {
    expect(esriSigningSecret({})).toEqual({ secret: 'devpassword', dedicated: false });
  });

  it('signs with the dedicated secret, so a MinIO-signed token stops working', async () => {
    const svc = service({ GRATIS_SIGNING_SECRET: REAL, MINIO_SECRET_KEY: MINIO });
    await expect(svc.resolve(tokenSignedWith(MINIO))).rejects.toThrow('Invalid token.');
    await expect(svc.resolve(tokenSignedWith(REAL))).resolves.toMatchObject({ id: 'u1', authKind: 'jwt' });
  });

  it('still accepts a MinIO-signed token on an install without the new secret', async () => {
    const svc = service({ MINIO_SECRET_KEY: MINIO });
    await expect(svc.resolve(tokenSignedWith(MINIO))).resolves.toMatchObject({ id: 'u1' });
    await expect(svc.resolve(tokenSignedWith(REAL))).rejects.toThrow('Invalid token.');
  });
});

describe('checkEsriSigningSecret', () => {
  const logger = () => ({ warn: jest.fn() });

  it('refuses each placeholder in production, in either variable', () => {
    for (const word of [...PLACEHOLDER_SECRETS, 'DevPassword']) {
      expect(() =>
        checkEsriSigningSecret(logger(), { NODE_ENV: 'production', GRATIS_SIGNING_SECRET: word, MINIO_SECRET_KEY: MINIO }),
      ).toThrow(/GRATIS_SIGNING_SECRET is empty or a well-known placeholder/);
      expect(() => checkEsriSigningSecret(logger(), { NODE_ENV: 'production', MINIO_SECRET_KEY: word })).toThrow(
        /MINIO_SECRET_KEY \(used because GRATIS_SIGNING_SECRET is not set\)/,
      );
    }
  });

  it('refuses an empty secret in production', () => {
    expect(() => checkEsriSigningSecret(logger(), { NODE_ENV: 'production' })).toThrow(/placeholder/);
    expect(() =>
      checkEsriSigningSecret(logger(), { NODE_ENV: 'production', GRATIS_SIGNING_SECRET: '', MINIO_SECRET_KEY: '' }),
    ).toThrow(/placeholder/);
  });

  it('accepts a real dedicated secret in production without a warning', () => {
    const log = logger();
    checkEsriSigningSecret(log, { NODE_ENV: 'production', GRATIS_SIGNING_SECRET: REAL, MINIO_SECRET_KEY: 'devpassword' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('accepts a real MinIO fallback in production and warns once', () => {
    const log = logger();
    checkEsriSigningSecret(log, { NODE_ENV: 'production', MINIO_SECRET_KEY: MINIO });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/GRATIS_SIGNING_SECRET is not set/);
    expect(log.warn.mock.calls[0][0]).toMatch(/deploy\.sh/);
  });

  it('accepts the development default outside production', () => {
    expect(() => checkEsriSigningSecret(logger(), { NODE_ENV: 'development', MINIO_SECRET_KEY: 'devpassword' })).not.toThrow();
    expect(() => checkEsriSigningSecret(logger(), { MINIO_SECRET_KEY: 'devpassword' })).not.toThrow();
    expect(() => checkEsriSigningSecret(logger(), { GRATIS_SIGNING_SECRET: 'devpassword' })).not.toThrow();
  });
});
