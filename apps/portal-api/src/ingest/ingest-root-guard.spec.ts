// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { IngestService } from './ingest.service.js';

// The OS temp dir is always an ingest root, so to observe a rejection
// the spec has to move that root somewhere it controls. `process.env`
// inside a jest sandbox is a copy the outer realm's `os.tmpdir()` never
// reads, so TMPDIR / TEMP cannot do it; the module is wrapped instead,
// delegating to the real implementation until a test says otherwise.
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...actual, tmpdir: jest.fn(actual.tmpdir) };
});
const tmpdirMock = tmpdir as jest.MockedFunction<typeof tmpdir>;
const realTmpdir = jest.requireActual<typeof import('node:os')>('node:os').tmpdir;

/**
 * Containment guard on the CSV sniff's file open.
 *
 * Two cases matter. The sibling-prefix one: a plain `startsWith` test
 * would accept `/tmp/gg-staging-evil` as living inside
 * `/tmp/gg-staging`, which is the classic way this check is written
 * wrong. And the symlink one: resolving the string says a link planted
 * under a root is inside it, while the open follows the link out, so
 * the guard has to compare what the filesystem says the path is.
 *
 * The guard realpaths its candidate, so every accepted path here is a
 * real file. The layout lives under one mkdtemp directory and the OS
 * temp root is pointed INTO it, because the real temp dir is always a
 * root and nothing created under it could ever be observed as outside.
 *
 *   <base>/tmp/gg-ingest-x/upload.csv      inside the (fake) temp root
 *   <base>/staging/abc/upload.csv          inside STAGING_DIR
 *   <base>/staging-evil/upload.csv         sibling with the same prefix
 *   <base>/outside/secret.csv              inside no root
 *   <base>/staging/abc/link -> <base>/outside   escape hatch
 */
const base = mkdtempSync(join(realTmpdir(), 'gg-guard-'));
const fakeTmp = join(base, 'tmp');
const staging = join(base, 'staging');
const stagingEvil = join(base, 'staging-evil');
const outside = join(base, 'outside');
const linkDir = join(staging, 'abc', 'link');

for (const dir of [
  join(fakeTmp, 'gg-ingest-x'),
  join(fakeTmp, 'gg-staging', 'abc'),
  join(staging, 'abc'),
  stagingEvil,
  outside,
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(fakeTmp, 'gg-ingest-x', 'upload.csv'), 'lat,lng\n');
writeFileSync(join(fakeTmp, 'gg-staging', 'abc', 'sightings.csv'), 'lat,lng\n');
writeFileSync(join(staging, 'abc', 'upload.csv'), 'lat,lng\n');
writeFileSync(join(stagingEvil, 'upload.csv'), 'lat,lng\n');
writeFileSync(join(outside, 'secret.csv'), 'lat,lng\n');

// A directory link rather than a file link: on Windows a file symlink
// needs SeCreateSymbolicLinkPrivilege (Developer Mode), while a
// junction does not, and a junction is exactly the reparse point
// realpath has to see through. If even that is refused the symlink
// case is skipped with the reason in the test name rather than passing
// vacuously.
let symlinkError: string | null = null;
try {
  symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
} catch (err) {
  symlinkError = err instanceof Error ? err.message : String(err);
}

describe('IngestService ingest-root containment', () => {
  // The guard is private and has no dependencies; reach it on the
  // prototype rather than standing up Nest for a pure path check.
  const guard = (p: string): Promise<string | null> =>
    (
      IngestService.prototype as unknown as {
        resolveInsideIngestRoot(c: string): Promise<string | null>;
      }
    ).resolveInsideIngestRoot.call({}, p);
  const isInside = async (p: string): Promise<boolean> => (await guard(p)) !== null;

  const savedStagingDir = process.env.STAGING_DIR;
  beforeEach(() => {
    tmpdirMock.mockReturnValue(fakeTmp);
  });
  afterEach(() => {
    tmpdirMock.mockReset();
    tmpdirMock.mockImplementation(realTmpdir);
    if (savedStagingDir === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = savedStagingDir;
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts a staged file under the temp dir', async () => {
    delete process.env.STAGING_DIR;
    await expect(
      isInside(join(fakeTmp, 'gg-staging', 'abc', 'sightings.csv')),
    ).resolves.toBe(true);
  });

  it('accepts a mkdtemp ingest dir under the temp dir', async () => {
    delete process.env.STAGING_DIR;
    await expect(isInside(join(fakeTmp, 'gg-ingest-x', 'upload.csv'))).resolves.toBe(true);
  });

  it('rejects a real file outside every root', async () => {
    delete process.env.STAGING_DIR;
    await expect(isInside(join(outside, 'secret.csv'))).resolves.toBe(false);
  });

  it('rejects a path that does not exist, even under a root', async () => {
    // Nothing to realpath means nothing to open; the guard says no
    // rather than passing a string the open will reject anyway.
    delete process.env.STAGING_DIR;
    await expect(isInside(join(fakeTmp, 'gg-ingest-x', 'missing.csv'))).resolves.toBe(false);
  });

  it('rejects traversal that climbs back out of a root', async () => {
    delete process.env.STAGING_DIR;
    await expect(
      isInside(join(fakeTmp, 'gg-ingest-x', '..', '..', 'outside', 'secret.csv')),
    ).resolves.toBe(false);
  });

  it('rejects the root itself, which is a directory and not a file', async () => {
    delete process.env.STAGING_DIR;
    await expect(isInside(fakeTmp)).resolves.toBe(false);
  });

  it('honours STAGING_DIR when prod points it at a named volume', async () => {
    process.env.STAGING_DIR = staging;
    await expect(isInside(join(staging, 'abc', 'upload.csv'))).resolves.toBe(true);
    await expect(isInside(join(outside, 'secret.csv'))).resolves.toBe(false);
  });

  it('does not treat a sibling with the same prefix as inside', async () => {
    // The reason this uses path.relative and not startsWith.
    process.env.STAGING_DIR = staging;
    await expect(isInside(join(stagingEvil, 'upload.csv'))).resolves.toBe(false);
  });

  it('still accepts the temp root when STAGING_DIR is set elsewhere', async () => {
    process.env.STAGING_DIR = staging;
    await expect(isInside(join(fakeTmp, 'gg-ingest-x', 'upload.csv'))).resolves.toBe(true);
  });

  it('tolerates a STAGING_DIR that does not exist yet', async () => {
    // Created on the first upload; a fresh container has none. The
    // temp root must keep working and the missing root must admit
    // nothing.
    process.env.STAGING_DIR = join(base, 'not-yet');
    await expect(isInside(join(fakeTmp, 'gg-ingest-x', 'upload.csv'))).resolves.toBe(true);
    await expect(isInside(join(base, 'not-yet', 'upload.csv'))).resolves.toBe(false);
  });

  (symlinkError === null ? it : it.skip)(
    symlinkError === null
      ? 'rejects a link under a root that points outside it'
      : `rejects a link under a root that points outside it (skipped: symlink refused: ${symlinkError})`,
    async () => {
      process.env.STAGING_DIR = staging;
      const viaLink = join(linkDir, 'secret.csv');
      // The string says staging; the filesystem says outside.
      expect(viaLink.startsWith(staging)).toBe(true);
      await expect(isInside(viaLink)).resolves.toBe(false);
    },
  );

  it('returns the REAL path, so the caller opens what was checked', async () => {
    // The guard hands back the filesystem's spelling of the path rather
    // than a boolean precisely so a caller cannot validate one spelling
    // and then open another.
    delete process.env.STAGING_DIR;
    const messy = join(fakeTmp, 'gg-staging', 'abc', '.', 'sightings.csv');
    const out = await guard(messy);
    expect(out).toBe(realpathSync.native(messy));
    // Normalised: the redundant "." segment is gone.
    expect(out).not.toContain(`${sep}.${sep}`);
  });
});
