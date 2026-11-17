// SPDX-License-Identifier: AGPL-3.0-or-later
import { inlineMdToHtml } from './inline-md';

describe('inlineMdToHtml', () => {
  it('leaves emphasis markers in a link href alone', () => {
    expect(inlineMdToHtml('[docs](https://x.org/a*b) and 2*3')).toBe(
      '<a href="https://x.org/a*b">docs</a> and 2*3',
    );
    expect(inlineMdToHtml('[c](https://x.org/`q`)')).toBe(
      '<a href="https://x.org/`q`">c</a>',
    );
  });
  it('still formats link text and the rest of the line', () => {
    expect(inlineMdToHtml('[**b**](https://x.org) *i*')).toBe(
      '<a href="https://x.org"><strong>b</strong></a> <em>i</em>',
    );
  });
  it('drops unsafe hrefs', () => {
    expect(inlineMdToHtml('[x](javascript:alert(1))')).not.toContain('href');
  });
});
