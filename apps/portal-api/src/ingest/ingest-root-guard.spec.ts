// SPDX-License-Identifier: AGPL-3.0-or-later
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IngestService } from './ingest.service';

/**
 * Containment guard on the CSV sniff's file open.
 *
 * The interesting case is the sibling-prefix one: a plain
 * `startsWith` test would accept `/tmp/gg-staging-evil` as living
 * inside `/tmp/gg-staging`, which is the classic way this check is
 * written wrong.
 */
describe('IngestService ingest-root containment', () => {
  // The guard is private and has no dependencies; reach it on the
  // prototype rather than standing up Nest for a pure path check.
  const isInside = (p: string): boolean =>
    (
      IngestService.prototype as unknown as {
        isInsideIngestRoot(c: string): boolean;
      }
    ).isInsideIngestRoot.call({}, p);

  const savedStagingDir = process.env.STAGING_DIR;
  afterEach(() => {
    if (savedStagingDir === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = savedStagingDir;
  });

  it('accepts a staged file under the temp dir', () => {
    delete process.env.STAGING_DIR;
    expect(
      isInside(join(tmpdir(), 'gg-staging', 'abc-123', 'sightings.csv')),
    ).toBe(true);
  });

  it('accepts a mkdtemp ingest dir under the temp dir', () => {
    delete process.env.STAGING_DIR;
    expect(isInside(join(tmpdir(), 'gg-ingest-x9f2', 'upload.csv'))).toBe(true);
  });

  it('rejects a path outside every root', () => {
    delete process.env.STAGING_DIR;
    expect(isInside(resolve('/etc/passwd'))).toBe(false);
  });

  it('rejects traversal that climbs back out of a root', () => {
    delete process.env.STAGING_DIR;
    expect(
      isInside(join(tmpdir(), 'gg-staging', '..', '..', 'etc', 'passwd')),
    ).toBe(false);
  });

  it('rejects the root itself, which is a directory and not a file', () => {
    delete process.env.STAGING_DIR;
    expect(isInside(tmpdir())).toBe(false);
  });

  it('honours STAGING_DIR when prod points it at a named volume', () => {
    process.env.STAGING_DIR = resolve('/srv/staging');
    expect(isInside(resolve('/srv/staging/abc/upload.csv'))).toBe(true);
    expect(isInside(resolve('/srv/other/upload.csv'))).toBe(false);
  });

  it('does not treat a sibling with the same prefix as inside', () => {
    // The reason this uses path.relative and not startsWith.
    process.env.STAGING_DIR = resolve('/srv/staging');
    expect(isInside(resolve('/srv/staging-evil/upload.csv'))).toBe(false);
  });

  it('still accepts the temp root when STAGING_DIR is set elsewhere', () => {
    process.env.STAGING_DIR = resolve('/srv/staging');
    expect(isInside(join(tmpdir(), 'gg-ingest-abc', 'f.csv'))).toBe(true);
  });
});
