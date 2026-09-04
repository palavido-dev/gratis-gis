// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guards the hand-duplicated contract in portal-web/public/sw.js.
 *
 * A service worker cannot import TypeScript, so sw.js restates the
 * offline queue's database name, store names, statuses, replay
 * endpoints, retry ladder and claim window by hand. Every one of those
 * is a place where a change on one side silently stops matching the
 * other, and the failure mode is the worst kind: background replay
 * quietly stops working, on devices, with no error anywhere. That has
 * already happened once for the claim window, where 60 s on one side
 * and 120 s on the other let each drain steal rows the other had in
 * flight.
 *
 * So the mirror gets a test. This reads the worker as text and checks
 * it still agrees with the values the app actually uses. It cannot
 * prove the logic matches, only that the constants and shapes do,
 * which is where the drift has historically been.
 *
 * It lives in shared-types because portal-web has no test runner; if
 * one is ever added, this belongs closer to the file it guards.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_CLAIM_STALE_MS } from './queue-replay.js';

// packages/shared-types/src -> repo root -> the worker.
const SW_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'portal-web',
  'public',
  'sw.js',
);

describe('service worker offline-queue contract', () => {
  // Fail loudly rather than skipping. A silent skip is how the
  // #215 void-column bug shipped: a suite that opts itself out looks
  // exactly like a suite that passed.
  it('can find the service worker to check', () => {
    expect(existsSync(SW_PATH)).toBe(true);
  });

  const sw = existsSync(SW_PATH) ? readFileSync(SW_PATH, 'utf8') : '';

  it('names the same database and stores the app writes', () => {
    // Mirrors OFFLINE_DB_NAME and STORES in portal-web offline-store.
    expect(sw).toContain("const OFFLINE_DB_NAME = 'gratisgis-offline'");
    expect(sw).toContain("const OFFLINE_QUEUE_STORE = 'queue'");
    expect(sw).toContain("const OFFLINE_DEPLOYMENTS_STORE = 'deployments'");
  });

  it('arms the same Background Sync tag the app registers', () => {
    // Mirrors BACKGROUND_SYNC_TAG in offline-store.
    expect(sw).toContain("const SYNC_TAG = 'gg-offline-queue'");
  });

  it('uses the shared claim window rather than its own', () => {
    const match = sw.match(/const CLAIM_STALE_MS = ([^;]+);/);
    expect(match).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const value = Number(new Function(`return (${match![1]})`)());
    expect(value).toBe(QUEUE_CLAIM_STALE_MS);
  });

  it('mirrors the retry ladder', () => {
    // Same schedule as RETRY_BACKOFF_MS in queue-replay.ts. Compared
    // through the exported helper rather than by re-reading the
    // private array, so the test breaks if either side moves.
    const match = sw.match(/const RETRY_BACKOFF_MS = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const swLadder = match![1]!
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    expect(swLadder.length).toBeGreaterThan(1);
    // queueRetryDelayMs is indexed by retryCount and clamps past the
    // end, so walking the worker's array must reproduce it exactly.
    // Imported lazily to keep the top of the file about the worker.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { queueRetryDelayMs } = require('./queue-replay.js') as {
      queueRetryDelayMs: (n: number | undefined) => number;
    };
    swLadder.forEach((ms, i) => {
      expect(queueRetryDelayMs(i)).toBe(ms);
    });
    expect(queueRetryDelayMs(swLadder.length + 10)).toBe(
      swLadder[swLadder.length - 1],
    );
  });

  it('recognises every syncStatus the app can write', () => {
    // 'rejected' is the one that matters: the worker must never claim
    // a parked row, and it learned that value later than the others.
    for (const status of ['pending', 'syncing', 'synced', 'failed', 'rejected']) {
      expect(sw).toContain(`'${status}'`);
    }
  });

  it('replays against the same endpoints as the in-app drain', () => {
    // offline-sync.ts builds /api/portal/items/<id>/layers/<key>/features
    // and appends /<globalId> for update and delete.
    expect(sw).toContain("'/api/portal/items/'");
    expect(sw).toContain("'/layers/'");
    expect(sw).toContain("'/features'");
    expect(sw).toContain('encodeURIComponent(r.layerKey)');
  });

  it('classifies replay outcomes the same way shared-types does', () => {
    // Mirror of replayOutcomeForStatus. Checking the transient set is
    // enough to catch the drift that matters: adding a status to one
    // table and not the other changes whether an edit is retried or
    // thrown away.
    expect(sw).toContain('function replayOutcomeForStatus(status, op)');
    for (const code of ['401', '408', '425', '429']) {
      expect(sw).toContain(code);
    }
    expect(sw).toContain("op === 'delete' && status === 404");
  });

  it('orders replay per feature instead of globally', () => {
    // Rows are keyed by operation id now, so one feature can have
    // several. Without chainHeads an update overtakes the insert it
    // depends on, 404s, and parks as terminally rejected.
    expect(sw).toContain('function chainHeads(rows, nowMs)');
    expect(sw).toContain('chainHeads(rows, now)');
  });

  it('still parses as JavaScript', () => {
    // Cheap smoke test: the worker is not typechecked, linted or
    // bundled, so a syntax error here ships to production and takes
    // offline mode with it.
    expect(() => new Function(sw)).not.toThrow();
  });
});
