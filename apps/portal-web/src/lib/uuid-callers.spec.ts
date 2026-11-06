// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * crypto.randomUUID is missing on http://<lan-ip>. The web client
 * mints ids through clientUuid, and this fails the suite if a new
 * call site reaches past that helper. The same member expression
 * is an ESLint error (see eslint.config.mjs); the scan stays here
 * so a string-built call does not slip past the AST rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const ALLOWED = new Set(['src/lib/uuid.ts', 'src/lib/uuid.spec.ts']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) out.push(path);
  }
}

/** Comments and quoted text, so a mention in prose is not a call. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

describe('browser ids', () => {
  it('does not call crypto.randomUUID outside clientUuid', () => {
    const files: string[] = [];
    walk(join(ROOT, 'src'), files);
    walk(join(ROOT, 'public'), files);
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const code = codeOnly(readFileSync(file, 'utf8'));
      if (/\.randomUUID\b|\[['"]randomUUID['"]\]/.test(code)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});
