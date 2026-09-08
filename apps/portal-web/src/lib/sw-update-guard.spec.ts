// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * The reload hold behind the service worker update.
 *
 * The one case worth pinning is the React shape: an effect keyed on a
 * value releases its hold in cleanup and re-takes it in the new body,
 * in the same synchronous tick. If the release reports idle before
 * the re-hold lands, the registrar reloads the page under an open
 * form, which is the data loss this module exists to prevent.
 *
 * The sets are module singletons, so every test loads a fresh copy of
 * the module rather than sharing state with its neighbours.
 */

type Guard = typeof import('./sw-update-guard');

function loadGuard(): Guard {
  let guard: Guard | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    guard = require('./sw-update-guard') as Guard;
  });
  return guard!;
}

/** Let every queued microtask run without touching timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('sw-update-guard', () => {
  it('reports busy on hold and idle after release', async () => {
    const guard = loadGuard();
    const seen: boolean[] = [];
    guard.onReloadHoldChange((busy) => seen.push(busy));

    const release = guard.holdReload('form');
    expect(guard.isReloadHeld()).toBe(true);
    expect(seen).toEqual([true]);

    release();
    expect(guard.isReloadHeld()).toBe(false);
    await flushMicrotasks();
    expect(seen).toEqual([true, false]);
  });

  it('keeps the hold until the last of two reasons releases', async () => {
    const guard = loadGuard();
    const seen: boolean[] = [];
    guard.onReloadHoldChange((busy) => seen.push(busy));

    const releaseForm = guard.holdReload('form');
    const releaseDownload = guard.holdReload('download');

    releaseForm();
    await flushMicrotasks();
    // The download is still running; the form closing must not free
    // the reload.
    expect(guard.isReloadHeld()).toBe(true);
    expect(seen).not.toContain(false);

    releaseDownload();
    await flushMicrotasks();
    expect(guard.isReloadHeld()).toBe(false);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('does not report idle when a release is followed by a hold in the same tick', async () => {
    // React runs the old effect cleanup and then the new effect body
    // synchronously when a dependency changes. From this module's
    // point of view that is release-then-hold with no gap, and it
    // must read as "still busy", never as a reload window.
    const guard = loadGuard();
    const seen: boolean[] = [];
    guard.onReloadHoldChange((busy) => seen.push(busy));

    const releaseFirst = guard.holdReload('form');
    releaseFirst();
    const releaseSecond = guard.holdReload('form');

    await flushMicrotasks();
    expect(seen).not.toContain(false);
    expect(guard.isReloadHeld()).toBe(true);

    releaseSecond();
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('ignores a second call to the same release', async () => {
    const guard = loadGuard();
    const seen: boolean[] = [];
    guard.onReloadHoldChange((busy) => seen.push(busy));

    const releaseA = guard.holdReload('a');
    guard.holdReload('b');
    releaseA();
    // A stale double release must not delete anything a second time
    // or emit a second idle: 'b' is still held.
    releaseA();
    await flushMicrotasks();
    expect(guard.isReloadHeld()).toBe(true);
    expect(seen).not.toContain(false);
  });

  it('unsubscribes a listener', async () => {
    const guard = loadGuard();
    const seen: boolean[] = [];
    const off = guard.onReloadHoldChange((busy) => seen.push(busy));
    off();
    const release = guard.holdReload('x');
    release();
    await flushMicrotasks();
    expect(seen).toEqual([]);
  });
});
