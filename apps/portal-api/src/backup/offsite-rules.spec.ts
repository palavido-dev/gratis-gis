// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  archiveArtifacts,
  selectExpired,
  stampFromName,
  staleNoticeKey,
  unreferencedObjects,
} from './offsite-rules.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('selectExpired (off-site retention)', () => {
  it('removes copies older than the window', () => {
    const out = selectExpired(
      [
        { id: 'new', createdAt: ago(1), complete: true },
        { id: 'old', createdAt: ago(40), complete: true },
        { id: 'older', createdAt: ago(50), complete: true },
      ],
      NOW,
      30,
    );
    expect(out.sort()).toEqual(['old', 'older']);
  });

  it('never removes the newest complete copy, however old', () => {
    const out = selectExpired(
      [
        { id: 'good-but-old', createdAt: ago(100), complete: true },
        { id: 'older', createdAt: ago(200), complete: true },
        { id: 'broken-newer', createdAt: ago(90), complete: false },
      ],
      NOW,
      30,
    );
    expect(out.sort()).toEqual(['broken-newer', 'older']);
  });

  it('keeps a recent incomplete copy (it may still be uploading)', () => {
    expect(
      selectExpired([{ id: 'partial', createdAt: ago(0.1), complete: false }], NOW, 30),
    ).toEqual([]);
  });

  it('removes nothing with a nonsense window', () => {
    expect(selectExpired([{ id: 'x', createdAt: ago(999), complete: false }], NOW, 0)).toEqual([]);
  });
});

describe('archiveArtifacts', () => {
  const p = 'gratisgis/archives/';
  it('groups archive and sidecar, and needs both to be complete', () => {
    const list = [
      { key: `${p}backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz.enc`, lastModified: null },
      { key: `${p}backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz.enc.json`, lastModified: null },
      { key: `${p}backup-2026-11-21T02-00-00-000-bbbbbbbb.tar.gz.enc`, lastModified: null },
      { key: `${p}backup-2026-11-22T02-00-00-000-cccccccc.tar.gz.enc.json`, lastModified: null },
      { key: `${p}notes.txt`, lastModified: null },
      { key: 'other/backup-2026-11-22T02-00-00-000-dddddddd.tar.gz.enc', lastModified: null },
    ];
    const out = archiveArtifacts(list, p);
    const byId = Object.fromEntries(out.map((a) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual([
      'backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz.enc',
      'backup-2026-11-21T02-00-00-000-bbbbbbbb.tar.gz.enc',
      'backup-2026-11-22T02-00-00-000-cccccccc.tar.gz.enc',
    ]);
    expect(byId['backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz.enc']!.complete).toBe(true);
    expect(byId['backup-2026-11-21T02-00-00-000-bbbbbbbb.tar.gz.enc']!.complete).toBe(false);
    // A sidecar alone is not a copy.
    expect(byId['backup-2026-11-22T02-00-00-000-cccccccc.tar.gz.enc']!.complete).toBe(false);
    expect(
      byId['backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz.enc']!.createdAt.toISOString(),
    ).toBe('2026-11-20T02:00:00.000Z');
  });
});

describe('stampFromName', () => {
  it('reads the time from a backup name', () => {
    expect(stampFromName('backup-2026-11-24T02-00-00-123-abcdef12.tar.gz')?.toISOString()).toBe(
      '2026-11-24T02:00:00.123Z',
    );
    expect(stampFromName('random')).toBeNull();
  });
});

describe('staleNoticeKey', () => {
  const base = { enabled: true, alertDays: 3, now: NOW };
  it('is quiet when off', () => {
    expect(
      staleNoticeKey({ ...base, enabled: false, lastSuccess: null, firstAttemptAt: ago(30) }),
    ).toBeNull();
  });
  it('is quiet inside the window', () => {
    expect(
      staleNoticeKey({
        ...base,
        lastSuccess: { runId: 'r1', at: ago(2) },
        firstAttemptAt: ago(30),
      }),
    ).toBeNull();
  });
  it('names the last good run once the window passes', () => {
    expect(
      staleNoticeKey({
        ...base,
        lastSuccess: { runId: 'r1', at: ago(4) },
        firstAttemptAt: ago(30),
      }),
    ).toBe('stale:r1');
  });
  it('with no success ever, counts from the first attempt', () => {
    expect(staleNoticeKey({ ...base, lastSuccess: null, firstAttemptAt: ago(1) })).toBeNull();
    expect(staleNoticeKey({ ...base, lastSuccess: null, firstAttemptAt: ago(5) })).toBe(
      'stale:none',
    );
    expect(staleNoticeKey({ ...base, lastSuccess: null, firstAttemptAt: null })).toBeNull();
  });
});

describe('unreferencedObjects', () => {
  it('lists old objects no run refers to, and keeps young ones', () => {
    const out = unreferencedObjects(
      [
        { key: 'a', lastModified: ago(10) },
        { key: 'b', lastModified: ago(10) },
        { key: 'c', lastModified: ago(1) },
        { key: 'd', lastModified: null },
      ],
      new Set(['a']),
      NOW,
    );
    expect(out).toEqual(['b']);
  });
});
