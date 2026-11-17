// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every literal key passed to `t()` must exist in the English
 * catalog. `t()` falls back to the key itself, so a missing key shows
 * `mapAttributeTable.exportCsv` on screen in every locale and no
 * catalog-to-catalog check notices. That is how sixty attribute-table
 * keys shipped under the wrong section.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { en } from './messages/en';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'messages') walk(path, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name)) out.push(path);
  }
}

function exists(key: string): boolean {
  let cursor: unknown = en;
  for (const seg of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(seg in cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return typeof cursor === 'string';
}

/** `t('a.b')`, `t("a.b")`, and `labelKey: 'a.b'` style key fields. */
const KEY_USES = [
  /\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g,
  /\bt\(\s*"([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)"/g,
  /\b[a-z]+Key:\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g,
];

describe('translation keys', () => {
  it('uses only keys the English catalog defines', () => {
    const files: string[] = [];
    walk(SRC, files);
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const re of KEY_USES) {
        for (const m of source.matchAll(re)) {
          if (!exists(m[1]!)) missing.push(`${relative(SRC, file)}: ${m[1]}`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
