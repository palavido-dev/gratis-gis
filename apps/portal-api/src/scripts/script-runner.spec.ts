// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiKeyService } from '../auth/api-key.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ScriptRunnerWorker } from './script-runner.worker.js';

/**
 * The environment handed to a script process is the security boundary
 * of this whole feature. A script is code the portal did not write,
 * running on the portal's own machine, so every variable it can read
 * is one it can exfiltrate.
 */
describe('script child environment', () => {
  const worker = new ScriptRunnerWorker(
    {} as unknown as PrismaService,
    {} as unknown as ApiKeyService,
  );
  // The method is private by design; nothing outside the worker should
  // build this. Reaching in is deliberate: this is exactly the thing
  // worth pinning.
  const childEnv = (token: string): NodeJS.ProcessEnv =>
    (
      worker as unknown as {
        childEnv: (t: string) => NodeJS.ProcessEnv;
      }
    ).childEnv(token);

  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('passes the run key so the script can reach the portal', () => {
    const env = childEnv('ggk_runtoken');
    expect(env.GRATISGIS_API_KEY).toBe('ggk_runtoken');
  });

  it('points the client at the portal, not at localhost by accident', () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    expect(childEnv('t').GRATISGIS_PORTAL_URL).toBe('https://gratisgis.org');
  });

  // The heart of it. These are real variables the worker container
  // holds; a script that could read any of them would be far more
  // privileged than the user who ran it.
  it.each([
    ['DATABASE_URL', 'postgresql://gratisgis:hunter2@postgres:5432/gratisgis'],
    ['MINIO_SECRET_KEY', 'root-object-storage-secret'],
    ['MINIO_ACCESS_KEY', 'root-object-storage-user'],
    ['KEYCLOAK_ADMIN_CLIENT_SECRET', 'keycloak-admin-secret'],
    ['CREDENTIAL_ENCRYPTION_KEY', 'credential-encryption-key'],
    ['FEEDBACK_IP_SALT', 'ip-hash-salt'],
    ['NEXTAUTH_SECRET', 'session-signing-secret'],
  ])('never leaks %s into the script process', (name, value) => {
    process.env[name] = value;
    const env = childEnv('t');
    expect(env[name]).toBeUndefined();
    // Belt and braces: not under any other name either.
    expect(Object.values(env)).not.toContain(value);
  });

  it('is built from nothing, so a secret added to compose later is private by default', () => {
    // This is the allowlist-versus-denylist property, stated as a
    // test. A denylist would pass every case above and still fail
    // this one, which is the case that actually happens: someone adds
    // a variable months from now and never thinks about scripts.
    process.env.SOME_FUTURE_SECRET_NOBODY_THOUGHT_ABOUT = 'sensitive';
    const env = childEnv('t');
    expect(env.SOME_FUTURE_SECRET_NOBODY_THOUGHT_ABOUT).toBeUndefined();
  });

  it('carries only the handful of variables a python process needs', () => {
    process.env.DATABASE_URL = 'postgresql://x';
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    const keys = Object.keys(childEnv('t')).sort();
    expect(keys).toEqual(
      expect.arrayContaining([
        'GRATISGIS_API_KEY',
        'GRATISGIS_PORTAL_URL',
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
      ]),
    );
    // Nothing beyond the known set (the two optional SSL vars
    // included). A growing environment here is a regression.
    for (const k of keys) {
      expect([
        'GRATISGIS_API_KEY',
        'GRATISGIS_PORTAL_URL',
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
      ]).toContain(k);
    }
  });

  it('forwards the CA bundle location when the image sets one', () => {
    // Slim python images put certifi somewhere non-default; without
    // this every https call from a script fails TLS verification and
    // the author gets a baffling error.
    process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';
    expect(childEnv('t').SSL_CERT_FILE).toBe(
      '/etc/ssl/certs/ca-certificates.crt',
    );
  });
});
