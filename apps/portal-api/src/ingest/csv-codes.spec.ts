// SPDX-License-Identifier: AGPL-3.0-or-later
import { isCodeLikeNumber } from './csv-codes.js';

describe('isCodeLikeNumber', () => {
  it('flags leading-zero codes and over-long ids', () => {
    expect(isCodeLikeNumber('02134')).toBe(true);
    expect(isCodeLikeNumber('01001')).toBe(true);
    expect(isCodeLikeNumber('1234567890123456')).toBe(true);
  });

  it('leaves ordinary numbers alone', () => {
    expect(isCodeLikeNumber('0')).toBe(false);
    expect(isCodeLikeNumber('0.5')).toBe(false);
    expect(isCodeLikeNumber('-12.25')).toBe(false);
    expect(isCodeLikeNumber('10001')).toBe(false);
  });
});
