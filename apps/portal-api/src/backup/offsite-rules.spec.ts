// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  archiveArtifacts,
  copyAttempt,
  COPY_NAME_RE,
  copyObjectName,
  FUTURE_MARGIN_MS,
  newestGood,
  selectExpired,
  stampFromName,
  staleNoticeKey,
  suspectDate,
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
      // Names the portal never writes: nested, or loosely matching.
      { key: `${p}sub/backup-2026-11-23T02-00-00-000-eeeeeeee.tar.gz.enc`, lastModified: null },
      {
        key: `${p}sub/backup-2026-11-23T02-00-00-000-eeeeeeee.tar.gz.enc.json`,
        lastModified: null,
      },
      { key: `${p}backup-x.tar.gz.enc`, lastModified: null },
      { key: `${p}backup-2026-11-23T02-00-00-000-EEEEEEEE.tar.gz.enc`, lastModified: null },
      { key: `${p}xbackup-2026-11-23T02-00-00-000-eeeeeeee.tar.gz.enc`, lastModified: null },
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

describe('copies dated in the future', () => {
  const HOUR = 60 * 60 * 1000;
  const future = new Date(NOW.getTime() + 2 * DAY);

  it('sets aside a name dated after now plus the margin, or after its upload', () => {
    expect(suspectDate({ id: 'a', createdAt: future, complete: true }, NOW)).toBe('future');
    expect(
      suspectDate(
        { id: 'b', createdAt: new Date(NOW.getTime() + FUTURE_MARGIN_MS / 2), complete: true },
        NOW,
      ),
    ).toBeNull();
    expect(
      suspectDate({ id: 'c', createdAt: ago(1), complete: true, lastModified: ago(3) }, NOW),
    ).toBe('after-upload');
    expect(
      suspectDate(
        {
          id: 'd',
          createdAt: ago(1),
          complete: true,
          lastModified: new Date(ago(1).getTime() + HOUR),
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('is never the newest good copy and never deleted by retention', () => {
    const list = [
      { id: 'planted', createdAt: future, complete: true },
      { id: 'good', createdAt: ago(40), complete: true },
      { id: 'older', createdAt: ago(50), complete: true },
    ];
    expect(newestGood(list, NOW)?.id).toBe('good');
    // Without the rule, "planted" would be kept as newest and "good" deleted.
    expect(selectExpired(list, NOW, 30)).toEqual(['older']);
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

describe('copy names', () => {
  const ARCHIVE = 'backup-2026-11-24T02-00-00-123-abcdef12.tar.gz';
  it('uses the archive name first, then a numbered name for each new attempt', () => {
    expect(copyObjectName(ARCHIVE, 1)).toBe(`${ARCHIVE}.enc`);
    expect(copyObjectName(ARCHIVE, 2)).toBe(
      'backup-2026-11-24T02-00-00-123-abcdef12-r2.tar.gz.enc',
    );
    expect(copyAttempt(copyObjectName(ARCHIVE, 1))).toBe(1);
    expect(copyAttempt(copyObjectName(ARCHIVE, 17))).toBe(17);
    expect(() => copyObjectName(ARCHIVE, 0)).toThrow();
    expect(() => copyObjectName(ARCHIVE, 1000)).toThrow();
  });
  it('accepts only names the portal writes', () => {
    expect(COPY_NAME_RE.test(ARCHIVE)).toBe(true);
    expect(COPY_NAME_RE.test('backup-2026-11-24T02-00-00-123-abcdef12-r2.tar.gz')).toBe(true);
    expect(COPY_NAME_RE.test('backup-2026-11-24T02-00-00-123-abcdef12-r1.tar.gz')).toBe(false);
    expect(COPY_NAME_RE.test('backup-2026-11-24T02-00-00-123-abcdef12-r1000.tar.gz')).toBe(false);
    expect(COPY_NAME_RE.test(`../${ARCHIVE}`)).toBe(false);
  });
  it('groups each attempt as its own copy with its own date', () => {
    const P = 'site/archives/';
    const second = copyObjectName(ARCHIVE, 2);
    const arts = archiveArtifacts(
      [
        { key: `${P}${ARCHIVE}.enc`, lastModified: NOW, size: 10 },
        { key: `${P}${second}`, lastModified: NOW, size: 12 },
        { key: `${P}${second}.json`, lastModified: NOW },
      ],
      P,
    );
    expect(arts.map((a) => [a.id, a.complete])).toEqual([
      [`${ARCHIVE}.enc`, false],
      [second, true],
    ]);
    expect(arts[1]!.createdAt.toISOString()).toBe('2026-11-24T02:00:00.123Z');
  });
});
