// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The walker appended text one character at a time, about 33 bytes of
// heap per character: a single large text node in an uploaded KML
// exhausted the API heap. Text runs are taken as one slice now.

import { parseXml } from './xml-walker.js';

describe('parseXml text', () => {
  it('keeps text, CDATA and entities', () => {
    const el = parseXml('<a><b>x &amp; y</b><c><![CDATA[<raw>]]></c><d>one<!-- no -->two</d></a>');
    expect(JSON.stringify(el)).toContain('x & y');
    expect(JSON.stringify(el)).toContain('<raw>');
    expect(JSON.stringify(el)).toContain('onetwo');
  });

  it('reads a 32 MB text node without a heap blow-up', () => {
    const big = 'x'.repeat(32 * 1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    const t = Date.now();
    parseXml(`<a><b>${big}</b></a>`);
    expect(Date.now() - t).toBeLessThan(5000);
    // One-character appends cost about 1 GB here.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(400 * 1024 * 1024);
  });
});
