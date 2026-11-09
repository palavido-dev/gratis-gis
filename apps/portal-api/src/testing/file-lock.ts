// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A blocking lock shared by every process on this machine, for test
// helpers that touch state Postgres keeps per cluster rather than per
// database. Jest runs suites in parallel worker processes, so an
// in-process mutex is not enough.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function holderAlive(path: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(path, 'utf8').trim());
  } catch {
    // Gone between our failed create and this read: not held.
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run `fn` while holding the lock file at `path`. The file holds the
 * owner's pid; a lock whose owner has exited is taken over, so a
 * crashed worker cannot block later runs. Throws after `timeoutMs`.
 *
 * Two waiters that both find a dead owner can both take over; that
 * needs a crashed worker and a race in the same run, and costs at
 * worst the overlap this lock exists to prevent. Test use only.
 */
export function withFileLock<T>(
  path: string,
  fn: () => T,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (fd !== null) {
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try {
          unlinkSync(path);
        } catch {
          // Already removed; nothing to release.
        }
      }
    }
    if (!holderAlive(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Another waiter removed it first.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${path}`);
    }
    sleepMs(pollMs);
  }
}
