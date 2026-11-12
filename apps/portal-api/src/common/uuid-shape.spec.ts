// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import { isUuidShape, UuidPathPipe } from './uuid-shape.js';

describe('UuidPathPipe', () => {
  const pipe = new UuidPathPipe('Item not found');

  it('passes a uuid-shaped id through, in any letter case', () => {
    const id = '11111111-1111-1111-1111-11111111AAAA';
    expect(pipe.transform(id)).toBe(id);
  });

  it('answers a malformed id as not found instead of reaching Prisma', () => {
    expect(() => pipe.transform('abc')).toThrow(NotFoundException);
    expect(() => pipe.transform('-'.repeat(36))).toThrow(NotFoundException);
    expect(() => pipe.transform(['a'])).toThrow(NotFoundException);
  });

  it('isUuidShape refuses non-strings', () => {
    expect(isUuidShape(5)).toBe(false);
    expect(isUuidShape(undefined)).toBe(false);
  });
});
