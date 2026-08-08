// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The container topology IS the isolation, so it deserves a test.
 *
 * What a script can reach is decided by which Docker network its
 * container joins, not by anything in TypeScript. A one-line edit to
 * compose (adding `- gratis-net` to the executor, say, or moving
 * postgres onto the script network for convenience during some future
 * debugging session) would silently hand user-authored Python a route
 * to the database, and no other test in this repo would notice.
 *
 * Measured before the split, on a real portal: a probe script opened
 * sockets to postgres:5432, minio:9000, and keycloak:8080. It had no
 * credentials for any of them, but "needs a password" is a weaker
 * property than "cannot open the socket", and only one of the two
 * survives a protocol-level CVE in one of those services.
 */
const compose = parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'infra', 'docker-compose.prod.yml'),
    'utf8',
  ),
) as {
  services: Record<
    string,
    {
      networks?: string[];
      environment?: Record<string, string>;
      command?: string[];
    }
  >;
  networks: Record<string, unknown>;
};

const SCRIPT_NET = 'gg-script-net';

describe('script executor isolation', () => {
  it('defines a separate network for user code', () => {
    expect(Object.keys(compose.networks)).toContain(SCRIPT_NET);
  });

  it('runs user Python in a container on that network ONLY', () => {
    const ex = compose.services['script-executor'];
    expect(ex).toBeDefined();
    expect(ex!.networks).toEqual([SCRIPT_NET]);
    // If this ever runs a different entry point, the assumption that
    // this is the process spawning Python no longer holds.
    expect(ex!.command).toEqual(['node', 'dist/script-executor.main.js']);
  });

  // The heart of it. These three are what a script must not be able to
  // open a socket to.
  it.each(['postgres', 'minio', 'keycloak'])(
    'keeps %s off the script network',
    (name) => {
      const svc = compose.services[name];
      expect(svc).toBeDefined();
      expect(svc!.networks ?? []).not.toContain(SCRIPT_NET);
    },
  );

  it('lets exactly the expected services onto the script network', () => {
    // Stated as an exhaustive list rather than a per-service check, so
    // ADDING something to that network fails here and has to be a
    // conscious decision with a reason.
    const members = Object.entries(compose.services)
      .filter(([, v]) => (v.networks ?? []).includes(SCRIPT_NET))
      .map(([k]) => k)
      .sort();
    expect(members).toEqual([
      // The one door a script is meant to use.
      'portal-api',
      // Runs the Python.
      'script-executor',
      // Hands it work; also on gratis-net, which is why it must not
      // be the thing running the Python.
      'script-runner',
    ]);
  });

  it('gives the executor no database, storage, or auth credentials', () => {
    const env = compose.services['script-executor']!.environment ?? {};
    const dangerous = Object.keys(env).filter((k) =>
      /DATABASE|MINIO|S3_|KEYCLOAK|CREDENTIAL|NEXTAUTH|POSTGRES/i.test(k),
    );
    expect(dangerous).toEqual([]);
  });

  it('keeps the database on the claimer, which does not run Python', () => {
    // The split only means something if the claimer stays a claimer.
    const claimer = compose.services['script-runner']!;
    expect(claimer.environment?.DATABASE_URL).toBeDefined();
    expect(claimer.command).toEqual(['node', 'dist/script-worker.main.js']);
  });

  it('does not cut the executor off from the internet', () => {
    // Not `internal: true` on purpose: the case this feature exists
    // for is refreshing a layer from a county REST endpoint. An
    // isolation change that broke egress would break the feature
    // while looking like a security win.
    const net = compose.networks[SCRIPT_NET] as
      | { internal?: boolean }
      | undefined;
    expect(net?.internal).not.toBe(true);
  });
});
