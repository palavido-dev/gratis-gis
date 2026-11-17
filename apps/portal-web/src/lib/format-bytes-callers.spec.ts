// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * format-bytes.ts says it is the one byte formatter. Private copies
 * kept coming back with their own precision and unit ladder (a 3 GB
 * file shown as "3072.0 MB"), so a new one fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

describe('byte formatting', () => {
  it('has no private byte formatter outside lib/format-bytes', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n) && !n.endsWith('.spec.ts')) files.push(p);
      }
    };
    walk(root);
    const copy = /\.toFixed\(\d\)\}\s*(KB|MB|GB)|\$\{\w+\} B`/;
    const hits = files
      .filter((f) => !f.endsWith(join('lib', 'format-bytes.ts')))
      .filter((f) => copy.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});
