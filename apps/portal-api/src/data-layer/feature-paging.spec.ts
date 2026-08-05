// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parsePagingParams,
} from './feature-paging.js';

const CURSOR = '019fd2cb-09b5-7410-8b95-2ae9f635dad7';

describe('parsePagingParams', () => {
  it('returns null when neither param is present, so the read stays whole', () => {
    // This is what every existing caller does, the map renderer
    // included. Anything but null here changes their responses.
    expect(parsePagingParams(undefined, undefined)).toBeNull();
  });

  it('pages on limit alone', () => {
    expect(parsePagingParams('250', undefined)).toEqual({
      pageSize: 250,
      after: null,
    });
  });

  it('pages on cursor alone, at the default size', () => {
    expect(parsePagingParams(undefined, CURSOR)).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
      after: CURSOR,
    });
  });

  it('treats an empty cursor as the start of the walk', () => {
    expect(parsePagingParams('10', '')).toEqual({ pageSize: 10, after: null });
  });

  // The point of rejecting rather than defaulting: a caller who
  // fat-fingers the limit believes it is holding a bounded read, and
  // would instead receive the whole layer.
  it.each([
    ['abc', 'not a number'],
    ['0', 'below the minimum'],
    ['-5', 'negative'],
    ['1.5', 'fractional'],
    ['', 'empty'],
    [String(MAX_PAGE_SIZE + 1), 'above the maximum'],
  ])('refuses limit=%s (%s)', (limit) => {
    expect(() => parsePagingParams(limit, undefined)).toThrow(
      BadRequestException,
    );
  });

  it('accepts exactly the maximum', () => {
    expect(parsePagingParams(String(MAX_PAGE_SIZE), undefined)).toEqual({
      pageSize: MAX_PAGE_SIZE,
      after: null,
    });
  });

  it('refuses a cursor that is not a feature id', () => {
    // Reaches the engine's ::uuid cast otherwise, turning a caller
    // mistake into a 500.
    expect(() => parsePagingParams(undefined, 'not-a-uuid')).toThrow(
      BadRequestException,
    );
    expect(() =>
      parsePagingParams(undefined, "'; DROP TABLE observation; --"),
    ).toThrow(BadRequestException);
  });
});
