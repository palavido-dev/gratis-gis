// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptExecutorService } from './script-executor.service.js';

/**
 * The unit spec next door asserts the shape of the environment object.
 * This one spawns a REAL interpreter with it, because the property
 * that matters is what a running process can observe, not what a
 * dictionary contains. A refactor that reintroduced inheritance
 * somewhere between building the object and calling spawn would pass
 * the unit test and fail here.
 *
 * Skipped when no interpreter is available rather than silently
 * passing; CI has one.
 */
function findPython(): string | null {
  // SCRIPT_PYTHON first: the runner image sets it to the venv
  // interpreter, and it is the only safe way to name one on Windows.
  const explicit = process.env.SCRIPT_PYTHON?.trim();
  const candidates = explicit ? [explicit] : [];

  // On Windows, do NOT probe bare `python` / `python3`. Both are App
  // Execution Aliases, and running one when no interpreter is
  // installed hands control to the Python Manager, which downloads and
  // installs a full runtime into the CURRENT WORKING DIRECTORY. An
  // earlier version of this file did exactly that and deposited 174 MB
  // of CPython into apps/portal-api. A test must not install software,
  // least of all into the repo it is testing.
  //
  // So on Windows this suite runs only when SCRIPT_PYTHON points at a
  // real interpreter, and skips otherwise. CI is Linux, where the
  // probe is just a probe.
  if (process.platform !== 'win32') {
    candidates.push('python3', 'python');
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'print(1)'], {
      encoding: 'utf8',
      // Never inherit a shell that could resolve an alias, and keep
      // the probe cheap.
      shell: false,
      timeout: 10_000,
    });
    if (probe.status === 0 && probe.stdout.trim() === '1') return candidate;
  }
  return null;
}

const PYTHON = findPython();
const d = PYTHON ? describe : describe.skip;

// Spawning a real interpreter is not a unit test's five seconds,
// especially the first cold start on a Windows box with a virus
// scanner in the path.
jest.setTimeout(30_000);

if (!PYTHON && process.env.REQUIRE_PYTHON_SPECS === '1') {
  throw new Error(
    'REQUIRE_PYTHON_SPECS=1 but no python interpreter was found; the ' +
      'script-runner integration suite would silently skip.',
  );
}

d('script runner, against a real interpreter', () => {
  const executor = new ScriptExecutorService();
  const childEnv = (token: string): NodeJS.ProcessEnv =>
    executor.childEnv(token);

  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-script-itest-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Run source the way the worker does, and return what it printed. */
  async function run(
    source: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ code: number | null; out: string; killed: boolean }> {
    const file = join(dir, `s${Math.random().toString(36).slice(2)}.py`);
    await writeFile(file, source, 'utf8');
    return new Promise((resolve) => {
      const child = spawn(PYTHON!, ['-I', '-u', file], {
        cwd: dir,
        env: childEnv('ggk_test_token'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let killed = false;
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.stderr.on('data', (b: Buffer) => (out += b.toString()));
      if (opts.timeoutMs) {
        const t = setTimeout(() => {
          killed = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs);
        t.unref();
      }
      child.on('close', (code) => resolve({ code, out, killed }));
    });
  }

  it('runs a script and captures what it prints', async () => {
    const r = await run('print("hello from a script")');
    expect(r.code).toBe(0);
    expect(r.out).toContain('hello from a script');
  });

  it('captures stderr too, so a traceback reaches the run log', async () => {
    const r = await run('raise ValueError("something went wrong")');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('ValueError');
    expect(r.out).toContain('something went wrong');
  });

  it('hands the script its run key', async () => {
    const r = await run(
      'import os; print("KEY=" + os.environ["GRATISGIS_API_KEY"])',
    );
    expect(r.code).toBe(0);
    // Tagged and matched as a line rather than compared against the
    // whole output: some interpreters print a banner or a warning of
    // their own first (the Windows launcher does, given an
    // environment this minimal), and the property under test is that
    // the key arrived, not that nothing else was said.
    expect(r.out.split(/\r?\n/)).toContain('KEY=ggk_test_token');
  });

  // The one that matters. A real process, really looking.
  //
  // Every assertion here is negative ("the secret is not present"),
  // which is exactly the shape that passes for the wrong reason when
  // the process never started and printed nothing. So each of these
  // first proves the script actually ran and produced output; only
  // then is the absence meaningful.
  it('cannot see the database URL even though the worker has one', async () => {
    process.env.DATABASE_URL = 'postgresql://gratisgis:hunter2@postgres:5432/x';
    const r = await run(
      'import os; print("SAW:" + os.environ.get("DATABASE_URL", "<absent>"))',
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('SAW:<absent>');
    expect(r.out).not.toContain('hunter2');
  });

  it('cannot see any of the worker secrets, by any route', async () => {
    process.env.MINIO_SECRET_KEY = 'minio-root-secret-value';
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'credential-key-value';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'keycloak-secret-value';
    // Dump the entire environment the child can observe and assert no
    // secret appears anywhere in it, rather than checking names one at
    // a time.
    const r = await run('import os; print(repr(dict(os.environ)))');
    expect(r.code).toBe(0);
    // Proof the dump happened: the one variable that SHOULD be there.
    expect(r.out).toContain('GRATISGIS_API_KEY');
    expect(r.out).not.toContain('minio-root-secret-value');
    expect(r.out).not.toContain('credential-key-value');
    expect(r.out).not.toContain('keycloak-secret-value');
  });

  it('SIGKILL stops a script that ignores SIGTERM', async () => {
    // A timeout a script can decline to honour is not a timeout. This
    // installs a SIGTERM handler and loops; only SIGKILL ends it.
    const r = await run(
      [
        'import signal, time',
        'signal.signal(signal.SIGTERM, lambda *a: print("ignoring SIGTERM"))',
        'print("started")',
        'time.sleep(60)',
      ].join('\n'),
      { timeoutMs: 1500 },
    );
    expect(r.killed).toBe(true);
    expect(r.out).toContain('started');
  }, 15_000);

  it('runs with -I, so the environment cannot steer the interpreter', async () => {
    // PYTHONPATH injection would be a way to smuggle a module into a
    // run. Isolated mode ignores it, and the scrub means it is not
    // there to ignore in the first place.
    process.env.PYTHONPATH = '/tmp/evil';
    const r = await run(
      'import os, sys; print("PYTHONPATH:" + os.environ.get("PYTHONPATH","<absent>")); print("/tmp/evil" in sys.path)',
    );
    expect(r.out).toContain('PYTHONPATH:<absent>');
    expect(r.out).toContain('False');
  });
});
