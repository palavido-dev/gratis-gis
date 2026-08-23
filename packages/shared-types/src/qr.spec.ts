// SPDX-License-Identifier: AGPL-3.0-or-later
import { encodeQr, qrSvg, __qrInternals } from './qr';
import golden from './__fixtures__/qr-golden.json';

/**
 * Three layers, because the failure mode here is a code that looks
 * fine and does not scan, and no single check catches that.
 *
 * 1. A known-answer test on the codeword stream, with the expected
 *    bytes computed independently (Python, from the spec's tables)
 *    rather than by this encoder. This is the only assertion here
 *    that could catch a wrong answer on day one; everything else
 *    only catches drift.
 * 2. Structural invariants: version boundaries, geometry, quiet zone.
 * 3. Golden matrices, as regression cover.
 *
 * The golden matrices are OUR output, not a library's, and that is
 * deliberate. The obvious approach, diffing against `segno`, was
 * tried and abandoned: segno emits an extra zero byte when the bit
 * stream is already byte-aligned after the terminator, and picks
 * masks that are not the lowest-penalty ones. Both encodings are
 * legal, so matrix equality would have pinned another library's
 * quirks rather than our correctness.
 *
 * What establishes correctness instead is decoding. Every matrix in
 * the fixture was rendered and read back by OpenCV's decoder, an
 * implementation entirely independent of this one, and all eight
 * round-trip to their input string. Re-run that with
 * `scripts/verify-qr-scannable.py` after touching this file. Doing so
 * caught the three real bugs here: LSB-first format bits, a zigzag
 * that skipped the timing column by substituting a local instead of
 * reassigning the loop variable (encoding one column twice and column
 * zero never), and a generator polynomial built lowest-degree-first
 * and then indexed as though it were highest-first.
 */

interface Golden {
  text: string;
  note: string;
  version: number;
  mask: number;
  rows: string[];
}

const CASES = golden as unknown as Golden[];

const hex = (a: Uint8Array) =>
  Array.from(a, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

describe('codeword stream (known answer)', () => {
  it('encodes HELLO at v1-M exactly as the spec tables require', () => {
    const { version, codewords, payload } = __qrInternals('HELLO');
    expect(version).toBe(1);
    // mode 0100, count 5, 'HELLO', 4-bit terminator, then alternating
    // 0xEC / 0x11 padding starting with 0xEC.
    expect(hex(codewords)).toBe(
      '40 54 84 54 C4 C4 F0 EC 11 EC 11 EC 11 EC 11 EC',
    );
    // ...followed by ten Reed-Solomon codewords over GF(256).
    expect(hex(payload)).toBe(
      '40 54 84 54 C4 C4 F0 EC 11 EC 11 EC 11 EC 11 EC ' +
        '23 73 23 99 EC 08 C9 F7 37 DF',
    );
  });

  it('starts padding at 0xEC even when the payload ends on an odd codeword', () => {
    // HELLO leaves seven codewords, so an implementation that keys the
    // alternation off the running length starts on 0x11 here.
    const { codewords } = __qrInternals('HELLO');
    expect(codewords[7]).toBe(0xec);
    expect(codewords[8]).toBe(0x11);
  });
});

describe('version selection', () => {
  it('fits 14 bytes in v1 and rolls to v2 at 15', () => {
    expect(encodeQr('x'.repeat(14)).version).toBe(1);
    expect(encodeQr('x'.repeat(15)).version).toBe(2);
  });

  it('counts UTF-8 bytes, not code units', () => {
    // Five 3-byte characters is 15 bytes and must roll to v2, exactly
    // like 15 ASCII characters. Measuring .length would keep it at v1
    // and silently truncate.
    expect(encodeQr('漢'.repeat(5)).version).toBe(
      encodeQr('x'.repeat(15)).version,
    );
  });

  it('rejects payloads past version 10 rather than truncating', () => {
    expect(() => encodeQr('x'.repeat(217))).toThrow(/exceeds version 10/);
  });
});

describe('golden matrices', () => {
  it('covers several versions', () => {
    expect(new Set(CASES.map((c) => c.version)).size).toBeGreaterThanOrEqual(4);
  });

  for (const c of CASES) {
    it(`${c.note} (v${c.version})`, () => {
      const r = encodeQr(c.text);
      expect(r.version).toBe(c.version);
      expect(r.mask).toBe(c.mask);
      expect(r.size).toBe(c.version * 4 + 17);
      expect(r.modules.map((row) => row.map((m) => (m ? '1' : '0')).join(''))).toEqual(
        c.rows,
      );
    });
  }

  it('is square at every size', () => {
    for (const c of CASES) {
      const r = encodeQr(c.text);
      expect(r.modules).toHaveLength(r.size);
      for (const row of r.modules) expect(row).toHaveLength(r.size);
    }
  });
});

describe('qrSvg', () => {
  it('surrounds the code with a quiet zone', () => {
    const { size } = encodeQr('https://gratisgis.org/field');
    expect(qrSvg('https://gratisgis.org/field')).toContain(
      `viewBox="0 0 ${size + 8} ${size + 8}"`,
    );
  });

  it('paints a light background, which scanners need', () => {
    expect(qrSvg('x')).toContain('fill="#ffffff"');
  });

  it('emits one path rather than a node per module', () => {
    expect(qrSvg('https://gratisgis.org/field').match(/<path/g)).toHaveLength(1);
  });
});
