// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { compileSafeWhere } from './postgis-where.js';

const allowed = new Set(['status', 'county', 'year', 'owner']);

describe('compileSafeWhere', () => {
  it('binds a string comparison', () => {
    const out = compileSafeWhere(`status = 'active'`, allowed, 0);
    expect(out.sql).toBe('"status" = $1');
    expect(out.params).toEqual(['active']);
  });

  it('keeps a doubled quote inside a string', () => {
    const out = compileSafeWhere(`owner = 'O''Brien'`, allowed, 2);
    expect(out.sql).toBe('"owner" = $3');
    expect(out.params).toEqual(["O'Brien"]);
  });

  it('compiles IS NULL, IN, AND, OR, and parentheses', () => {
    const out = compileSafeWhere(`(year >= 2020 AND year < 2024) OR status IS NULL`, allowed, 0);
    expect(out.sql).toBe('((("year" >= $1 AND "year" < $2)) OR "status" IS NULL)');
    expect(out.params).toEqual([2020, 2024]);
  });

  it('compiles NOT IN and ILIKE', () => {
    const out = compileSafeWhere(`county NOT IN ('A', 'B') AND status ILIKE 'open%'`, allowed, 0);
    expect(out.sql).toBe('("county" NOT IN ($1, $2) AND "status" ILIKE $3)');
    expect(out.params).toEqual(['A', 'B', 'open%']);
  });

  it('allows a comparison between two known columns', () => {
    const out = compileSafeWhere(`status = county`, allowed, 0);
    expect(out.sql).toBe('"status" = "county"');
    expect(out.params).toEqual([]);
  });

  it('refuses a column the layer does not expose', () => {
    expect(() => compileSafeWhere(`secret = 'x'`, allowed, 0)).toThrow(BadRequestException);
  });

  it('refuses a function call, a comment, and a second statement', () => {
    for (const clause of [
      `status = current_user`,
      `status = 'a' --`,
      `status = 'a'; SELECT 1`,
      `(SELECT 1)`,
      `status = 'a' UNION SELECT 1`,
    ]) {
      expect(() => compileSafeWhere(clause, allowed, 0)).toThrow(BadRequestException);
    }
  });
});
