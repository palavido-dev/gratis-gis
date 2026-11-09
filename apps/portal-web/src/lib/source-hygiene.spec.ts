// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Text corruption that reached users once and is cheap to catch:
 * - a UTF-8 byte order mark, which an editor round-trip left on
 *   wizard.tsx along with double-encoded text;
 * - mojibake such as `Â·` (a `·` decoded as Latin-1 and re-encoded),
 *   which rendered in the New Item wizard;
 * - the Tailwind v4 codemod's `outline` -> `outline-solid` rename
 *   applied to prose, which turned "Magic outline" into
 *   "Magic outline-solid" in every catalog.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(name) && !name.endsWith('source-hygiene.spec.ts')) {
      out.push(path);
    }
  }
}

const files: string[] = [];
walk(SRC, files);

describe('source text hygiene', () => {
  it('has no byte order marks', () => {
    const hits = files.filter((f) => {
      const b = readFileSync(f);
      return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    });
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('has no double-encoded UTF-8', () => {
    const mojibake = /\u00c2[\u00a0-\u00bf]|\u00c3[\u0080-\u00bf]|\u00ef\u00bf\u00bd/;
    const hits = files.filter((f) => mojibake.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('keeps Tailwind class names out of user-facing text', () => {
    const prose = files.filter(
      (f) => f.includes(join('lib', 'i18n', 'messages')) || f.endsWith('sam-outline.ts'),
    );
    const hits = prose.filter((f) => /outline-solid/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });
});
