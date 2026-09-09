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
 * it still agrees with the values the app actually uses. For the pure
 * functions it goes one step further: it lifts the worker's own source
 * for a function (and the constants it closes over) into a Function
 * and runs it against the shared-types original, so the LOGIC is
 * compared and not just the spelling.
 *
 * It lives in shared-types because the functions it compares against
 * are exported from here. portal-web does have a jest runner now
 * (src/lib only), so a check that needs portal-web modules on the
 * other side belongs there instead.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isQueueRowOwnedBy, QUEUE_CLAIM_STALE_MS } from './queue-replay.js';
import { replayOutcomeForStatus } from './sync-outcome.js';

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

/** Source of a top-level `function name(...) { ... }` in the worker,
 *  `async` or not. The worker's functions all close at a brace in
 *  column 0, so the first `\n}` after the signature ends the body;
 *  nested braces are indented and never match. The `async` keyword has
 *  to be captured with the declaration: lifting an async body into a
 *  plain function is a syntax error at the first `await`. */
function functionSource(sw: string, name: string): string {
  const m = sw.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`),
  );
  if (!m) throw new Error(`sw.js no longer defines function ${name}`);
  return m[0];
}

/** Source of a top-level `const NAME = <expr>;` in the worker. */
function constSource(sw: string, name: string): string {
  const m = sw.match(new RegExp(`const ${name} =\\s*([^;]+);`));
  if (!m) throw new Error(`sw.js no longer defines const ${name}`);
  return `const ${name} = ${m[1]};`;
}

/**
 * Lift a worker function out of sw.js as a live function, in a scope
 * holding the named top-level constants and helper functions it
 * closes over. This is how the spec compares the worker's LOGIC with
 * shared-types rather than grepping for strings.
 */
function liftFunction<T>(
  sw: string,
  name: string,
  deps: { constants?: string[]; functions?: string[] } = {},
): T {
  const scope = [
    ...(deps.constants ?? []).map((c) => constSource(sw, c)),
    ...(deps.functions ?? []).map((f) => functionSource(sw, f)),
    functionSource(sw, name),
  ];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`${scope.join('\n')}\nreturn ${name};`)() as T;
}

describe('service worker offline-queue contract', () => {
  // Fail loudly rather than skipping. A silent skip is how the
  // #215 void-column bug shipped: a suite that opts itself out looks
  // exactly like a suite that passed.
  it('can find the service worker to check', () => {
    expect(existsSync(SW_PATH)).toBe(true);
  });

  const sw = existsSync(SW_PATH) ? readFileSync(SW_PATH, 'utf8') : '';

  it('names the same database and stores the app writes', () => {
    // Mirrors OFFLINE_DB_NAME, STORES, OFFLINE_META_STORE and
    // OFFLINE_IDENTITY_KEY in portal-web offline-store.
    expect(sw).toContain("const OFFLINE_DB_NAME = 'gratisgis-offline'");
    expect(sw).toContain("const OFFLINE_QUEUE_STORE = 'queue'");
    expect(sw).toContain("const OFFLINE_DEPLOYMENTS_STORE = 'deployments'");
    expect(sw).toContain("const OFFLINE_BLOBS_STORE = 'blobs'");
    expect(sw).toContain("const OFFLINE_META_STORE = 'meta'");
    expect(sw).toContain("const OFFLINE_IDENTITY_KEY = 'identity'");
  });

  it('sends a row only under the account that captured it', () => {
    // The worker's ownership rule, run against the shared-types
    // original over every combination that matters: a row owned by
    // the current identity, a row owned by somebody else, a legacy row
    // with no owner, and each of those with no identity on the device
    // at all. A mismatch here is one person's captures being attributed
    // to another, with no error anywhere.
    const swOwned = liftFunction<
      (row: { ownerUserId?: string }, currentUserId: string | null) => boolean
    >(sw, 'isQueueRowOwnedBy');
    const rows = [
      { ownerUserId: 'alice' },
      { ownerUserId: 'bob' },
      {},
    ];
    const identities = ['alice', 'bob', null];
    for (const row of rows) {
      for (const identity of identities) {
        expect(swOwned(row, identity)).toBe(isQueueRowOwnedBy(row, identity));
      }
    }
    // The three outcomes the rule exists for, stated outright so the
    // test still says something if the export ever changes shape.
    expect(swOwned({ ownerUserId: 'alice' }, 'alice')).toBe(true);
    expect(swOwned({ ownerUserId: 'alice' }, 'bob')).toBe(false);
    expect(swOwned({ ownerUserId: 'alice' }, null)).toBe(false);
    expect(swOwned({}, 'bob')).toBe(true);
    expect(swOwned({}, null)).toBe(true);
  });

  it('reads the device identity and filters the queue by it before draining', () => {
    // The rule above is only worth anything if the drain applies it
    // before it picks chain heads (so a foreign row is never a head)
    // and again inside the claim predicate (the re-read is what a
    // concurrent drain sees). Both call sites are pinned by shape.
    expect(sw).toMatch(/const identity = await readOfflineIdentity\(db\)/);
    expect(sw).toMatch(
      /const rows = allRows\.filter\(\(r\) => isQueueRowOwnedBy\(r, identity\)\)/,
    );
    expect(sw).toMatch(
      /isQueueRowOwnedBy\(r, identity\) && isQueueRowClaimable\(r, Date\.now\(\)\)/,
    );
    // The identity read tolerates a database the page has not upgraded
    // to v3 yet: no meta store means no identity, not a thrown drain.
    expect(functionSource(sw, 'readOfflineIdentity')).toContain(
      'objectStoreNames.contains(OFFLINE_META_STORE)',
    );
  });

  it('leaves features alone while they still owe a file upload', () => {
    // The worker cannot run the presign + PUT + register walk, so it
    // must not drain a feature whose photo is still on the device:
    // doing so would delete the queue row and report the record
    // synced while the file it exists to carry was never sent. The
    // in-app drain picks those up.
    expect(sw).toContain('owesUpload');
    expect(sw).toMatch(/const blobs = await idbGetAll\(db, OFFLINE_BLOBS_STORE\)/);
  });

  it('opens the app database without a version', () => {
    // The blobs store arrived as schema v2. A versionless open never
    // up- or downgrades, which is what keeps a future bump in
    // offline-store from making this worker throw VersionError.
    expect(sw).toContain('indexedDB.open(name)');
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

  it('never claims a parked or finished row', () => {
    // 'rejected' is the one that matters: the worker must never claim
    // a parked row, and it learned that value later than the others.
    // Run the worker's own claimability rule rather than grepping for
    // the string.
    const claimable = liftFunction<
      (row: Record<string, unknown>, nowMs: number) => boolean
    >(sw, 'isQueueRowClaimable', {
      constants: ['CLAIM_STALE_MS', 'RETRY_BACKOFF_MS'],
      functions: ['queueRetryDelayMs'],
    });
    const now = Date.now();
    expect(claimable({ syncStatus: 'rejected' }, now)).toBe(false);
    expect(claimable({ syncStatus: 'synced' }, now)).toBe(false);
    expect(claimable({ syncStatus: 'pending' }, now)).toBe(true);
    expect(claimable({ syncStatus: 'failed' }, now)).toBe(true);
    // A fresh claim is left alone; a stale one is reclaimed.
    expect(
      claimable(
        { syncStatus: 'syncing', lastAttemptAt: new Date(now).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      claimable(
        {
          syncStatus: 'syncing',
          lastAttemptAt: new Date(now - QUEUE_CLAIM_STALE_MS - 1).toISOString(),
        },
        now,
      ),
    ).toBe(true);
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
    // The worker's replayOutcomeForStatus, run over every status for
    // every op and compared with the export. Adding a transient code
    // to one table and not the other changes whether an edit is
    // retried or thrown away, and this used to be checked by grepping
    // for '425', which would have passed with the number in a comment.
    const swOutcome = liftFunction<
      (status: number, op: 'insert' | 'update' | 'delete') => string
    >(sw, 'replayOutcomeForStatus');
    for (const op of ['insert', 'update', 'delete'] as const) {
      for (let status = 0; status < 600; status += 1) {
        expect(swOutcome(status, op)).toBe(replayOutcomeForStatus(status, op));
      }
    }
  });

  it('does not treat data-layer MVT tiles as cacheable tiles', () => {
    // Our own /items/:id/layers/:key/tile/z/x/y.mvt ends like a slippy
    // tile, but the server invalidates it on every write and sets a
    // short private max-age. The cache-first tile path has no TTL, so
    // caching it there hid every edit from every other tab. Basemap
    // tiles, cross-origin or relayed through an item proxy, must still
    // be cached: the field map needs them offline.
    const isTileRequest = liftFunction<(url: URL) => boolean>(
      sw,
      'isTileRequest',
      {
        constants: [
          'DATA_LAYER_TILE_PATTERN',
          'TILE_PATH_PATTERN',
          'TILE_QUERY_PATTERN',
          'STYLE_JSON_PATTERN',
        ],
      },
    );
    expect(
      isTileRequest(new URL('https://x/api/portal/items/a/layers/b/tile/14/1/2.mvt')),
    ).toBe(false);
    expect(
      isTileRequest(
        new URL('https://x/api/public/items/a/layers/b/tile/14/1/2.mvt?refresh=1'),
      ),
    ).toBe(false);
    expect(isTileRequest(new URL('https://tile.openstreetmap.org/14/1/2.png'))).toBe(
      true,
    );
    expect(
      isTileRequest(new URL('https://x/api/portal/items/a/proxy/14/1/2.png')),
    ).toBe(true);
    expect(
      isTileRequest(new URL('https://wms.example/ows?SERVICE=WMS&REQUEST=GetMap')),
    ).toBe(true);
    expect(isTileRequest(new URL('https://x/api/portal/items/a/geojson'))).toBe(false);
  });

  it('orders replay per feature instead of globally', () => {
    // Rows are keyed by operation id now, so one feature can have
    // several. Without chainHeads an update overtakes the insert it
    // depends on, 404s, and parks as terminally rejected.
    expect(sw).toContain('function chainHeads(rows, nowMs)');
    expect(sw).toContain('chainHeads(rows, now)');
  });

  it('caps the geojson and page caches and trims them oldest-first', async () => {
    // Neither cache had a cap: every layer ever viewed and every field
    // page ever opened stayed until the next deploy. The constants are
    // read back as numbers (a cap of 0 or NaN would silently empty the
    // cache on every write), and the trim itself is lifted and run
    // against a fake Cache whose keys() is insertion-ordered, which is
    // the only clock it has.
    const capOf = (name: string): number => {
      const m = sw.match(new RegExp(`const ${name} = ([^;]+);`));
      expect(m).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      return Number(new Function(`return (${m![1]})`)());
    };
    const geojsonCap = capOf('GEOJSON_CACHE_CAP');
    const pagesCap = capOf('PAGES_CACHE_CAP');
    expect(Number.isInteger(geojsonCap) && geojsonCap > 0).toBe(true);
    expect(Number.isInteger(pagesCap) && pagesCap > 0).toBe(true);
    // Both write paths wire their cap in, and delete before put so a
    // refetch counts as fresh rather than keeping its old slot.
    expect(sw).toMatch(
      /networkFirstWithCache\(request, GEOJSON_CACHE, GEOJSON_CACHE_CAP\)/,
    );
    expect(sw).toMatch(/trimCache\(cache, PAGES_CACHE_CAP, isPrecachedShellPath\)/);
    expect(sw).toMatch(/cache\s*\.delete\(request\)\s*\.then\(\(\) => cache\.put\(request, copy\)\)/);
    expect(sw).toMatch(/await cache\.delete\(key\);\s*await cache\.put\(key, response\.clone\(\)\);/);

    type FakeRequest = { url: string };
    const trimCache = liftFunction<
      (
        cache: {
          keys: () => Promise<FakeRequest[]>;
          delete: (req: FakeRequest) => Promise<boolean>;
        },
        cap: number,
        isExempt: (pathname: string) => boolean,
      ) => Promise<void>
    >(sw, 'trimCache');
    const entries = [
      'https://x/field/offline.html',
      'https://x/items/a/field',
      'https://x/items/b/field',
      'https://x/items/c/field',
      'https://x/items/d/field',
    ].map((url) => ({ url }));
    const deleted: string[] = [];
    const fake = {
      keys: async () => entries.filter((e) => !deleted.includes(e.url)),
      delete: async (req: FakeRequest) => {
        deleted.push(req.url);
        return true;
      },
    };
    await trimCache(fake, 3, (p) => p === '/field/offline.html');
    // Two over the cap: the two OLDEST non-exempt entries go, the
    // exempt shell at the very front is skipped, and the newest survive.
    expect(deleted).toEqual(['https://x/items/a/field', 'https://x/items/b/field']);
    expect((await fake.keys()).map((e) => e.url)).toEqual([
      'https://x/field/offline.html',
      'https://x/items/c/field',
      'https://x/items/d/field',
    ]);
    // Under the cap, nothing moves.
    deleted.length = 0;
    await trimCache(fake, 10, () => false);
    expect(deleted).toEqual([]);
  });

  it('never trims the precached shell out of the page cache', () => {
    // The install step and the trim exemption read the same list, so
    // adding a precached page to one cannot leave it evictable in the
    // other.
    const isPrecachedShellPath = liftFunction<(pathname: string) => boolean>(
      sw,
      'isPrecachedShellPath',
      { constants: ['FIELD_OFFLINE_SHELL', 'PRECACHED_SHELL_PATHS'] },
    );
    expect(sw).toMatch(/cache\.addAll\(PRECACHED_SHELL_PATHS\)/);
    expect(isPrecachedShellPath('/field/offline.html')).toBe(true);
    expect(isPrecachedShellPath('/items/a/field')).toBe(false);
    expect(isPrecachedShellPath('/field')).toBe(false);
  });

  it('still parses as JavaScript', () => {
    // Cheap smoke test: the worker is not typechecked, linted or
    // bundled, so a syntax error here ships to production and takes
    // offline mode with it.
    expect(() => new Function(sw)).not.toThrow();
  });
});
