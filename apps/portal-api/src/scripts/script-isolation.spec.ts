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
      user?: string;
      cap_drop?: string[];
      cap_add?: string[];
      security_opt?: string[];
      cpus?: number | string;
      pids_limit?: number;
      mem_limit?: string;
      tmpfs?: string[];
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

  // The environment scrub stops a script INHERITING variables. It does
  // not stop it reading /proc/1/environ, which is readable by the
  // owning UID. Measured: a script running as the executor's own user
  // recovered the executor's entire environment, SCRIPT_EXECUTOR_TOKEN
  // included. A separate UID is what actually closes that, and it
  // needs the capabilities below.
  it('can drop the script to a separate user, and holds only the privilege to do so', () => {
    const ex = compose.services['script-executor']!;
    expect(ex.user).toBe('0:0');
    expect(ex.cap_drop).toEqual(['ALL']);
    // SETUID/SETGID to change the child's user, CHOWN to hand it its
    // own scratch directory. Nothing else, ever.
    expect([...(ex.cap_add ?? [])].sort()).toEqual([
      'CHOWN',
      'SETGID',
      'SETUID',
    ]);
    expect(ex.security_opt).toContain('no-new-privileges:true');
  });

  it('bounds what a runaway script can consume', () => {
    const ex = compose.services['script-executor']!;
    // Before these, a `while True: pass` had every core on the box and
    // a fork bomb had ~9000 processes.
    expect(typeof ex.cpus === 'number' ? ex.cpus : Number(ex.cpus)).
      toBeGreaterThan(0);
    expect(ex.pids_limit).toBeGreaterThan(0);
    expect(ex.mem_limit).toBeDefined();
  });

  it('caps the scratch a run can write, as RAM not disk', () => {
    // The fourth limit, and the one that was missing while the other
    // three looked complete. CPU, memory, and pids were capped; writes
    // were not, so a script could fill the host root filesystem and
    // take postgres and the site down with it. Measured on prod: 27 GiB
    // free and nothing in the way.
    //
    // A tmpfs is charged to this container's memory cgroup, so the
    // scratch budget and the memory budget are the same number and
    // overrunning it kills the run rather than the machine.
    const tmpfs = compose.services['script-executor']!.tmpfs ?? [];
    const scratch = tmpfs.find((m) => m.startsWith('/var/tmp/ggscript'));
    expect(scratch).toBeDefined();
    expect(scratch).toMatch(/size=\d+m/);
  });

  it('keeps the executor environment free of anything worth stealing', () => {
    // A script CAN read the executor's environment off /proc when the
    // UIDs match, and the UID split is defence rather than proof. The
    // durable guarantee is that there is nothing there worth reading.
    // This list is the allowlist; adding to it should require thought.
    const env = compose.services['script-executor']!.environment ?? {};
    expect(Object.keys(env).sort()).toEqual([
      'ENABLE_CRONS',
      'NODE_ENV',
      'PORTAL_BASE_URL',
      'SCRIPT_EXECUTOR_PORT',
      // Grants nothing a script does not already have: it authenticates
      // calls to the executor, and a script is already running inside
      // one.
      'SCRIPT_EXECUTOR_TOKEN',
      'SKIP_MIGRATE',
    ]);
  });

  it('ships the egress fence that Docker networking does not provide', () => {
    // Grep rather than parse, because there is nothing to parse: this
    // is a shell script, and the alternative is not testing a control
    // that two measured holes depend on.
    //
    // Both halves are asserted because the second one is easy to lose.
    // Traffic to the bridge gateway is addressed to the host and never
    // traverses FORWARD, so a rule that only touches DOCKER-USER reads
    // correctly in a diff and blocks nothing.
    const fence = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'infra', 'script-net-firewall.sh'),
      'utf8',
    );
    expect(fence).toContain('169.254.0.0/16');
    expect(fence).toContain('DOCKER-USER');
    expect(fence).toMatch(/iptables -I INPUT/);
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
