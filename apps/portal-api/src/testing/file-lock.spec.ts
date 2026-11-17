// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileLock } from './file-lock.js';

describe('withFileLock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-file-lock-'));

  it('runs the function, returns its value and releases the lock', () => {
    const path = join(dir, 'a.lock');
    const seen: string[] = [];
    const out = withFileLock(path, () => {
      seen.push(readFileSync(path, 'utf8'));
      return 42;
    });
    expect(out).toBe(42);
    expect(seen).toEqual([String(process.pid)]);
    expect(existsSync(path)).toBe(false);
  });

  it('releases the lock when the function throws', () => {
    const path = join(dir, 'b.lock');
    expect(() =>
      withFileLock(path, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(path)).toBe(false);
  });

  it('waits while a live process holds the lock, then times out', () => {
    const path = join(dir, 'c.lock');
    // Our own pid is alive, so this lock counts as held.
    writeFileSync(path, String(process.pid));
    const ran = jest.fn();
    expect(() => withFileLock(path, ran, { timeoutMs: 200, pollMs: 20 })).toThrow(
      /timed out/,
    );
    expect(ran).not.toHaveBeenCalled();
  });

  it('takes over a lock whose owner has exited', async () => {
    const path = join(dir, 'd.lock');
    const child = spawn(process.execPath, ['-e', '0']);
    const pid = child.pid!;
    await new Promise((r) => child.on('exit', r));
    writeFileSync(path, String(pid));
    expect(withFileLock(path, () => 'ok', { timeoutMs: 1000 })).toBe('ok');
  });

  it('takes over a lock file with no readable pid once it has gone stale', () => {
    const path = join(dir, 'e.lock');
    writeFileSync(path, 'not-a-pid');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(withFileLock(path, () => 'ok', { timeoutMs: 1000 })).toBe('ok');
  });

  it('treats a fresh empty lock as held: its owner is still writing the pid', () => {
    const path = join(dir, 'f.lock');
    writeFileSync(path, '');
    const ran = jest.fn();
    expect(() => withFileLock(path, ran, { timeoutMs: 200, pollMs: 20 })).toThrow(
      /timed out/,
    );
    expect(ran).not.toHaveBeenCalled();
  });
});
