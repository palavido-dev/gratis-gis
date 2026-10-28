// SPDX-License-Identifier: AGPL-3.0-or-later
import { groupWhatsNewByRelease, parseEntries } from './whats-new';

describe('parseEntries', () => {
  it('parses date-named entries without a release banner', () => {
    const entries = parseEntries(`# What's new

## 2026-10-28 - First feature
Does a useful thing.

## 2026-10-27 - Second feature
Does another thing.
`);
    expect(entries).toEqual([
      {
        date: '2026-10-28',
        name: 'First feature',
        description: 'Does a useful thing.',
      },
      {
        date: '2026-10-27',
        name: 'Second feature',
        description: 'Does another thing.',
      },
    ]);
  });

  it('stamps following entries with a Keep-a-Changelog release banner', () => {
    const entries = parseEntries(`# What's new

## [0.9.120] - 2026-10-28

## 2026-10-28 - Group by from Analyze
Creates a derived layer.

## 2026-10-28 - Contour from Analyze
Creates contour lines.

## [0.9.118] - 2026-10-27

## 2026-10-27 - Buffer from Analyze
Honest meter buffers.
`);
    expect(entries.map((e) => ({ name: e.name, release: e.release }))).toEqual([
      { name: 'Group by from Analyze', release: '0.9.120' },
      { name: 'Contour from Analyze', release: '0.9.120' },
      { name: 'Buffer from Analyze', release: '0.9.118' },
    ]);
    expect(entries[0]?.releaseDate).toBe('2026-10-28');
  });

  it('accepts an optional v inside the release brackets', () => {
    const entries = parseEntries(`## [v0.9.120] - 2026-10-28

## 2026-10-28 - Feature
Body.
`);
    expect(entries[0]?.release).toBe('0.9.120');
  });

  it('clears the release stamp on ## [earlier]', () => {
    const entries = parseEntries(`## [0.9.120] - 2026-10-28

## 2026-10-28 - New
Body.

## [earlier]

## 2026-10-27 - Old
Body.
`);
    expect(entries[0]?.release).toBe('0.9.120');
    expect(entries[1]?.release).toBeUndefined();
  });
});

describe('groupWhatsNewByRelease', () => {
  it('groups consecutive same-release entries and keeps earlier unversioned', () => {
    const groups = groupWhatsNewByRelease([
      {
        date: '2026-10-28',
        name: 'A',
        description: 'a',
        release: '0.9.120',
        releaseDate: '2026-10-28',
      },
      {
        date: '2026-10-28',
        name: 'B',
        description: 'b',
        release: '0.9.120',
        releaseDate: '2026-10-28',
      },
      { date: '2026-10-27', name: 'C', description: 'c' },
      { date: '2026-10-26', name: 'D', description: 'd' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      release: '0.9.120',
      releaseDate: '2026-10-28',
    });
    expect(groups[0]!.entries.map((e) => e.name)).toEqual(['A', 'B']);
    expect(groups[1]).toMatchObject({ release: null, releaseDate: null });
    expect(groups[1]!.entries.map((e) => e.name)).toEqual(['C', 'D']);
  });
});
