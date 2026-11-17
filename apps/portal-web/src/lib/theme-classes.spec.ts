// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Colour utilities that name a theme token globals.css does not
 * define generate no CSS at all in Tailwind v4, so the element just
 * inherits: an unreadable label on an accent button, a status pill
 * with no colour. These three names were used in place of the real
 * tokens (warn, accent-foreground, border) in a dozen files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');
const DEAD =
  /\b(?:text|bg|border|ring|fill|stroke|divide|outline)-(?:warning|accent-ink|line)(?=[/\s"'`]|$)/gm;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.spec.ts')) out.push(path);
  }
}

describe('theme colour classes', () => {
  it('only name colours the theme defines', () => {
    const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
    for (const token of ['warn', 'accent-foreground', 'border']) {
      expect(css).toContain(`--color-${token}:`);
    }
    const files: string[] = [];
    walk(SRC, files);
    const hits: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(DEAD)) {
        hits.push(`${relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
