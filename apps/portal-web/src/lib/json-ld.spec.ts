// SPDX-License-Identifier: AGPL-3.0-or-later
import { serializeJsonLd } from './json-ld';

describe('serializeJsonLd', () => {
  it('cannot close the surrounding script element', () => {
    const out = serializeJsonLd({
      name: 'x</script><script>alert(1)</script>',
      keywords: ['a<!--<script>'],
    });
    expect(out).not.toMatch(/[<>]/);
    expect(out.toLowerCase()).not.toContain('</script');
  });

  it('round-trips to the same value', () => {
    const value = {
      name: 'A & B <tag> \u2028 line \u2029 para',
      n: 3,
      list: ['x', null, true],
    };
    expect(JSON.parse(serializeJsonLd(value))).toEqual(value);
  });

  it('escapes the JavaScript line terminators', () => {
    const out = serializeJsonLd('a\u2028b\u2029c');
    expect(out).toBe('"a\\u2028b\\u2029c"');
  });
});

describe('JSON-LD call sites', () => {
  // A JSON-LD block filled with raw JSON.stringify is the stored XSS
  // this helper closes. Fail if any block skips it.
  it('serialize every ld+json block through serializeJsonLd', () => {
    const { readdirSync, readFileSync, statSync } = jest.requireActual<
      typeof import('node:fs')
    >('node:fs');
    const { join, relative } = jest.requireActual<typeof import('node:path')>(
      'node:path',
    );
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name)) files.push(path);
      }
    };
    walk(join(root, 'src'));
    const bad: string[] = [];
    let blocks = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const re = /application\/ld\+json"[\s\S]{0,400}?__html:\s*([^\n]+)/g;
      for (const m of source.matchAll(re)) {
        blocks += 1;
        if (!m[1]!.trim().startsWith('serializeJsonLd(')) {
          bad.push(relative(root, file));
        }
      }
    }
    expect(blocks).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
