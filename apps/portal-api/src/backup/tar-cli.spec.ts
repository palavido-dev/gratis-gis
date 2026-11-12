// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTarEntry } from './tar-cli.js';

/**
 * The manifest peek now asks tar to stop after the first match. It
 * must still return the entry, and null for a missing one.
 */
describe('readTarEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-tar-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the first entry and reports a missing one as null', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{"v":1}');
    writeFileSync(join(dir, 'other.txt'), 'x');
    const file = join(dir, 'a.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', dir, 'manifest.json', 'other.txt']);
    expect((await readTarEntry(file, 'manifest.json'))?.toString()).toBe('{"v":1}');
    expect(await readTarEntry(file, 'nope.json')).toBeNull();
  });
});
