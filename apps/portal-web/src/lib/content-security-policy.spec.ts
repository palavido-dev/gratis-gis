// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read as text: jest cannot import the .mjs module directly.
const source = readFileSync(join(__dirname, 'content-security-policy.mjs'), 'utf8');

describe('PAGE_CSP', () => {
  it('lets the COG decoder start its workers from data: and blob: URLs', () => {
    const workerSrc = /"(worker-src [^"]+)"/.exec(source)![1]!;
    expect(workerSrc.split(' ')).toEqual(expect.arrayContaining(["'self'", 'blob:', 'data:']));
  });
});
