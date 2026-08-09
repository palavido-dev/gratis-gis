// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Request } from 'express';

import { ScriptExecutorService } from './script-executor.service.js';

/**
 * The environment handed to a script process is one of two security
 * boundaries for this feature. It controls what a script can READ.
 *
 * The other is the network the executor container sits on, which
 * controls what a script can CONNECT to, and no amount of care in
 * this file substitutes for it: a script in the original
 * single-container design had none of the variables below and could
 * still open a socket to postgres:5432. Both boundaries, or neither
 * counts.
 */
describe('script child environment', () => {
  const executor = new ScriptExecutorService();
  const childEnv = (token: string): NodeJS.ProcessEnv =>
    executor.childEnv(token);

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
    expect(childEnv('t').GRATISGIS_URL).toBe('https://gratisgis.org');
  });

  // The runner shipped injecting GRATISGIS_PORTAL_URL while the client
  // reads GRATISGIS_URL. Both sides were wrong in the same way, so the
  // unit test agreed with the bug and the first real run died on
  // "Missing environment variable(s): GRATISGIS_URL".
  //
  // Asserting the literal here would just re-encode the same guess, so
  // this reads the names out of the client's own from_env and checks
  // the runner satisfies them. If the client renames a variable, this
  // fails, which is the point: those two names are a contract shared
  // with every person who exports them on their laptop.
  it('supplies exactly the variables the python client reads', () => {
    const clientSource = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'clients',
        'python',
        'src',
        'gratisgis',
        'client.py',
      ),
      'utf8',
    );
    const fromEnv = clientSource.slice(clientSource.indexOf('def from_env'));
    const required = [
      ...new Set(
        [...fromEnv.slice(0, 900).matchAll(/os\.environ\.get\("([A-Z_]+)"\)/g)]
          .map((m) => m[1] as string),
      ),
    ];
    // Sanity: if the parse found nothing, the assertion below would
    // pass vacuously and this test would be decoration.
    expect(required.length).toBeGreaterThan(0);
    expect(required).toContain('GRATISGIS_URL');

    const env = childEnv('ggk_token');
    for (const name of required) {
      expect(Object.keys(env)).toContain(name);
      expect(env[name]).toBeTruthy();
    }
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
        'GRATISGIS_URL',
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
      ]),
    );
    // Nothing beyond the known set (the optional SSL vars and the temp
    // redirects included). A growing environment here is a regression:
    // the point is that a secret added to compose later is NOT here.
    // TMPDIR/TMP/TEMP and PYTHONNOUSERSITE were added so a read-only
    // executor still has a writable, bounded temp dir and the notebook
    // path ignores any per-user site dir.
    for (const k of keys) {
      expect([
        'GRATISGIS_API_KEY',
        'GRATISGIS_URL',
        'HOME',
        'TMPDIR',
        'TMP',
        'TEMP',
        'PYTHONNOUSERSITE',
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

// ---------------------------------------------------------------------
// The claimer -> executor hop
// ---------------------------------------------------------------------

describe('ScriptExecutorController forwards the whole request', () => {
  // Notebooks shipped broken because this hop dropped `format`. The
  // claimer detected the notebook correctly and the executor service
  // branched on it correctly; the controller destructures the body by
  // hand, `format` was not in the list, and it vanished with no error.
  // Every notebook then ran as Python and died on the first line of its
  // own JSON.
  //
  // Testing the two ends in isolation could never catch that, which is
  // the point of this block: it asserts what the controller PASSES ON,
  // not what it receives.
  const makeController = () => {
    const calls: Array<Record<string, unknown>> = [];
    const executor = {
      execute: jest.fn(async (req: Record<string, unknown>) => {
        calls.push(req);
        return { exitCode: 0, log: '', killedBy: null, notebook: null };
      }),
    };
    process.env.SCRIPT_EXECUTOR_TOKEN = 'tok';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      ScriptExecutorController,
    } = require('./script-executor.controller.js');
    const controller = new ScriptExecutorController(executor);
    const req = { on: jest.fn() } as unknown as Request;
    return { controller, calls, req };
  };

  const body = {
    source: 'print(1)',
    apiKeyToken: 'ggk_x',
    timeoutSeconds: 60,
    maxLogBytes: 4096,
  };

  it('passes format through to the service', async () => {
    const { controller, calls, req } = makeController();
    await controller.execute({ ...body, format: 'notebook' }, 'tok', req);
    expect(calls[0]!.format).toBe('notebook');
  });

  it('passes the notebook size cap through', async () => {
    const { controller, calls, req } = makeController();
    await controller.execute(
      { ...body, format: 'notebook', maxNotebookBytes: 2048 },
      'tok',
      req,
    );
    expect(calls[0]!.maxNotebookBytes).toBe(2048);
  });

  it('defaults to python when no format is sent', async () => {
    // An older claimer mid-deploy must behave the way it always did.
    const { controller, calls, req } = makeController();
    await controller.execute({ ...body }, 'tok', req);
    expect(calls[0]!.format).toBe('python');
  });

  it('treats an unrecognised format as python rather than trusting it', async () => {
    const { controller, calls, req } = makeController();
    await controller.execute({ ...body, format: 'wasm' }, 'tok', req);
    expect(calls[0]!.format).toBe('python');
  });

  it('forwards every field the claimer sends', async () => {
    // The guard against the next one going missing: if the service's
    // request shape grows a field, this fails until the controller
    // forwards it too.
    const { controller, calls, req } = makeController();
    await controller.execute({ ...body, format: 'notebook' }, 'tok', req);
    expect(Object.keys(calls[0]!).sort()).toEqual([
      'apiKeyToken',
      'format',
      'maxLogBytes',
      'maxNotebookBytes',
      'source',
      'timeoutSeconds',
    ]);
  });
});
