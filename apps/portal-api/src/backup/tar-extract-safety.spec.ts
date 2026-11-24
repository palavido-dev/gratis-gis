// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A restored archive comes from a bucket, so it is unpacked as if it
 * could have been planted. With the system tar (GNU tar in the image)
 * nothing lands outside the staging folder: leading "/" is stripped,
 * ".." members are refused, and a file is never written through a
 * symbolic link the archive made. The restore helper then puts back
 * regular files only, never what a link points at.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeS3 } from '../testing/fake-s3.js';
import { runCli, type CliIo } from './offsite-cli.js';
import { extractTarGz } from './tar-cli.js';

const gnuTar = (() => {
  try {
    return /GNU tar/.test(execFileSync('tar', ['--version']).toString());
  } catch {
    return false;
  }
})();
const d = gnuTar ? describe : describe.skip;

d('unpacking a planted archive', () => {
  let dir: string;
  let outside: string;
  let stage: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'gg-tarsafe-'));
    outside = join(dir, 'outside');
    stage = join(dir, 'stage');
    fs.mkdirSync(outside);
    fs.mkdirSync(stage);
    fs.writeFileSync(join(outside, 'target'), 'original');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Every file under `root`, symbolic links included, as relative paths. */
  const tree = (root: string): string[] =>
    (fs.readdirSync(root, { recursive: true }) as string[]).sort();

  it('strips a leading "/" so an absolute name lands inside the folder', async () => {
    const abs = join(outside, 'abs-file');
    fs.writeFileSync(abs, 'x');
    const archive = join(dir, 'abs.tar.gz');
    execFileSync('tar', ['-czPf', archive, abs], { stdio: 'ignore' });
    fs.rmSync(abs);
    await extractTarGz(archive, stage).catch(() => undefined);
    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(join(stage, abs.slice(1)))).toBe(true);
  });

  it('refuses a ".." member', async () => {
    const src = join(dir, 'src', 'inner');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(join(dir, 'src', 'escaped'), 'x');
    const archive = join(dir, 'dotdot.tar.gz');
    execFileSync('tar', ['-czPf', archive, '-C', src, '../escaped'], { stdio: 'ignore' });
    await expect(extractTarGz(archive, stage)).rejects.toThrow(/\.\./);
    expect(fs.existsSync(join(dir, 'escaped'))).toBe(false);
    expect(tree(stage)).toEqual([]);
  });

  it('never writes a file through a link the archive made, and the restore skips the link', async () => {
    const a = join(dir, 'a', 'minio');
    const b = join(dir, 'b', 'minio', 'escdir');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.symlinkSync(outside, join(a, 'esc'));
    fs.writeFileSync(join(b, 'target'), 'planted');
    fs.writeFileSync(join(dir, 'b', 'minio', 'real.txt'), 'real');
    const archive = join(dir, 'link.tar.gz');
    execFileSync(
      'tar',
      [
        '-czf',
        archive,
        '-C',
        join(dir, 'a'),
        'minio/esc',
        '-C',
        join(dir, 'b'),
        '--transform',
        's,^minio/escdir,minio/esc,',
        'minio/escdir/target',
        'minio/real.txt',
      ],
      { stdio: 'ignore' },
    );
    await expect(extractTarGz(archive, stage)).rejects.toThrow();
    expect(fs.readFileSync(join(outside, 'target'), 'utf8')).toBe('original');

    // The restore helper on the same archive: only the regular file goes back.
    const local = new FakeS3();
    const errs: string[] = [];
    const io: CliIo = {
      out: () => undefined,
      err: (l) => errs.push(l),
      stdin: async () => '',
      env: () => undefined,
      readFile: async (p) => fs.readFileSync(p),
      offsite: () => new FakeS3(),
      local: () => ({ s3: local, bucket: 'gratisgis' }),
    };
    // tar reports the refused member and stops with an error, so the
    // helper fails without putting anything back.
    expect(await runCli(['put-objects', '--archive', archive], io)).toBe(1);
    expect([...local.objects.keys()].filter((k) => k.startsWith('esc'))).toEqual([]);
    expect(fs.readFileSync(join(outside, 'target'), 'utf8')).toBe('original');
    // Nothing unpacked is left next to the archive.
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.offsite-objects-'))).toEqual([]);
  });
});
