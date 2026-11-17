// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every "latest observation per entity" collapse must break ties on
// id. Two observations of one entity can share (valid_from, tx_time)
// at millisecond resolution, and without the tiebreak the tile, the
// feature list, the head check of a guarded write and the append
// dedupe can each pick a different head. Ids are uuidv7, so id DESC
// is the later write. This reads the SQL in the source, so a new
// collapse without the tiebreak fails here.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

describe('latest-per-entity collapse ordering', () => {
  const files = sourceFiles(SRC);

  it('finds the collapses it checks', () => {
    const hits = files.filter((f) =>
      /ORDER BY[^\n]*valid_from DESC, (?:\w+\.)?tx_time DESC/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.length).toBeGreaterThan(5);
  });

  it('breaks ties on id after valid_from and tx_time', () => {
    const missing: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (!/ORDER BY[^\n]*valid_from DESC, (?:\w+\.)?tx_time DESC/.test(line)) return;
        if (!/tx_time DESC, (?:\w+\.)?id DESC/.test(line)) {
          missing.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it('does not filter valid_to inside the tables service collapses', () => {
    // Filtering before the collapse resurrects an entity whose newest
    // observation was closed: the collapse then picks an older row.
    const tables = readFileSync(join(SRC, 'data-layer', 'tables.service.ts'), 'utf8');
    expect(tables).not.toMatch(/valid_to IS NULL/);
  });
});
