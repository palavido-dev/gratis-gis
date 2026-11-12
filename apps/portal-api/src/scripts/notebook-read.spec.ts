// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptExecutorService } from './script-executor.service.js';

/**
 * The executed notebook lives in a directory the script can write. A
 * script could leave a FIFO there (the read blocked forever and the
 * single run queue with it) or a symlink to a file the executor can
 * read (returned as the run's notebook). Only a regular file is read.
 */
describe('ScriptExecutorService.readNotebook', () => {
  let dir: string;
  const read = (path: string, max = 1024) =>
    (new ScriptExecutorService() as unknown as {
      readNotebook: (p: string, m: number) => Promise<string | null>;
    }).readNotebook(path, max);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nb-read-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a regular file', async () => {
    await writeFile(join(dir, 'executed.ipynb'), '{"cells":[]}');
    await expect(read(join(dir, 'executed.ipynb'))).resolves.toBe('{"cells":[]}');
  });

  it('refuses a symlink', async () => {
    await writeFile(join(dir, 'secret'), 'root only');
    await symlink(join(dir, 'secret'), join(dir, 'executed.ipynb'));
    await expect(read(join(dir, 'executed.ipynb'))).resolves.toBeNull();
  });

  it('returns at once for a FIFO instead of blocking', async () => {
    execFileSync('mkfifo', [join(dir, 'executed.ipynb')]);
    await expect(read(join(dir, 'executed.ipynb'))).resolves.toBeNull();
  });

  it('refuses a file over the size cap', async () => {
    await writeFile(join(dir, 'executed.ipynb'), 'x'.repeat(2000));
    await expect(read(join(dir, 'executed.ipynb'), 1000)).resolves.toBeNull();
  });
});
