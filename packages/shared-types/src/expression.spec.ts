// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  analyzeExpression,
  compileExpressionSql,
  evaluateExpressionValue,
  ExpressionError,
  fieldRefTypeFor,
  isSqlSafeFieldName,
  parseExpression,
  toSqlSafeFieldName,
  validateExpression,
  evaluateExpression,
  FUNCTIONS,
  type FieldRef,
} from './expression.js';

const SCHEMA: FieldRef[] = [
  { name: 'acres', type: 'number' },
  { name: 'owner', type: 'string' },
  { name: 'sampled', type: 'date' },
  { name: 'tags', type: 'list' },
  { name: 'active', type: 'boolean' },
];

const check = (src: string) => validateExpression(parseExpression(src), SCHEMA);
const NOW = Date.UTC(2026, 10, 23, 18, 30); // 2026-11-23T18:30Z
const run = (src: string, properties: Record<string, unknown> = {}, extra: object = {}) =>
  evaluateExpressionValue(src, { fields: SCHEMA, properties, now: NOW, ...extra });

describe('parser', () => {
  it('accepts SQL, Arcade and JS spellings of the operators', () => {
    expect(run('1 = 1 and 2 <> 3')).toBe(true);
    expect(run('1 == 1 && !(2 != 2) || false')).toBe(true);
    expect(run('$feature.acres * 2', { acres: 3 })).toBe(6);
    expect(run('$feature["acres"] + 1', { acres: 3 })).toBe(4);
  });

  it('parses IN, BETWEEN, LIKE, IS NULL and CASE', () => {
    expect(run("{{owner}} in ('Baker', 'Carter')", { owner: 'Baker' })).toBe(true);
    expect(run("{{owner}} not in ('Baker')", { owner: 'Baker' })).toBe(false);
    expect(run('{{acres}} between 1 and 5', { acres: 5 })).toBe(true);
    expect(run('{{acres}} not between 1 and 5', { acres: 6 })).toBe(true);
    expect(run("{{owner}} like 'Ba%'", { owner: 'Baker' })).toBe(true);
    expect(run("{{owner}} ilike 'ba%'", { owner: 'Baker' })).toBe(true);
    expect(run("{{owner}} not like 'Ba_'", { owner: 'Baker' })).toBe(true);
    expect(run('{{owner}} is null', {})).toBe(true);
    expect(run('{{owner}} is not null', { owner: 'x' })).toBe(true);
    expect(run("case when {{acres}} > 10 then 'big' when {{acres}} > 1 then 'mid' else 'small' end", { acres: 5 })).toBe('mid');
    expect(run("case {{owner}} when 'A' then 1 when 'B' then 2 end", { owner: 'B' })).toBe(2);
    expect(run("CASE WHEN ({{acres}} > 1) THEN 'y' END", { acres: 2 })).toBe('y');
  });

  it('parses the Arcade When() function and comments', () => {
    expect(run("When({{acres}} > 10, 'big', 'small') // size", { acres: 3 })).toBe('small');
  });

  it('points at the problem', () => {
    expect(() => parseExpression('1 +')).toThrow(ExpressionError);
    try {
      parseExpression("upper({{owner}}");
    } catch (e) {
      expect((e as ExpressionError).pos).toBe(15);
    }
    expect(() => parseExpression('owner == 1')).toThrow(/Fields are written \{\{owner\}\}/);
  });
});

describe('fieldRefTypeFor', () => {
  it('maps every declared field type, with multi_select becoming list', () => {
    expect(fieldRefTypeFor('multi_select')).toBe('list');
    expect(fieldRefTypeFor('date')).toBe('date');
  });
});

describe('type checking', () => {
  it('lets a date compare with a date or with text, not with a number', () => {
    expect(check('{{sampled}} < {{sampled}}')).toEqual([]);
    expect(check("{{sampled}} >= '2020-01-01'")).toEqual([]);
    expect(check('{{sampled}} > 2020')).toHaveLength(1);
  });

  it('sends date arithmetic to date_add and date_diff', () => {
    expect(check('{{sampled}} - 1')[0]).toMatch(/date_add\(\) or date_diff\(\)/);
  });

  it('catches acres + owner, and suggests number()', () => {
    // + with text joins text, so the error appears where text cannot go.
    expect(check('{{acres}} * {{owner}}')[0]).toMatch(/use number\(\)/);
    expect(check('{{acres}} + {{owner}}')).toEqual([]);
  });

  it('allows list equality and membership but not ordering', () => {
    expect(check("{{tags}} == 'oak'")).toEqual([]);
    expect(check('{{tags}} == {{tags}}')).toEqual([]);
    expect(check("{{tags}} < 'oak'")).toHaveLength(1);
    expect(check("'oak' in {{tags}}")).toEqual([]);
    expect(check('{{tags}} * 2')[0]).toMatch(/is a list/);
  });

  it('suggests the right case for a misspelt field', () => {
    expect(check('{{Acres}} > 1')[0]).toMatch(/did you mean acres/);
  });

  it('checks function arguments and literal units', () => {
    expect(check("date_add({{sampled}}, 1, 'fortnights')")[0]).toMatch(/'years'/);
    expect(check('round({{owner}})')[0]).toMatch(/needs a number/);
    expect(check('round(1, 2, 3)')[0]).toMatch(/takes 1 to 2 values/);
    expect(check('nope(1)')[0]).toMatch(/Unknown function/);
  });

  it('reports positions', () => {
    const r = analyzeExpression('1 + {{nope}}', { fields: SCHEMA });
    expect(r.issues[0]!.pos).toBe(4);
  });

  it('leaves unknown-typed fields to runtime conversion', () => {
    const loose: FieldRef[] = [{ name: 'x', type: 'unknown' }];
    expect(validateExpression(parseExpression('{{x}} + 1'), loose)).toEqual([]);
  });

  it('returns arity errors for an empty coalesce or if, without throwing', () => {
    expect(check('coalesce()').join(' ')).toMatch(/at least two/);
    expect(() => check('if()')).not.toThrow();
  });
});

describe('evaluation: nulls', () => {
  it('treats == against an empty value as false and != as true', () => {
    expect(run("{{owner}} == 'a'", {})).toBe(false);
    expect(run("{{owner}} != 'a'", {})).toBe(true);
    expect(run('{{owner}} == null', {})).toBe(true);
    expect(run('{{owner}} != null', { owner: 'x' })).toBe(true);
  });

  it('propagates null through arithmetic and skips it in concatenation', () => {
    expect(run('{{acres}} + 1', {})).toBe(null);
    expect(run("{{owner}} ~~ '!'", {})).toBe('!');
    expect(run("'Owner: ' + {{owner}}", {})).toBe('Owner: ');
  });

  it('reads non-numeric text in a number field as empty', () => {
    expect(run('{{acres}} is null', { acres: 'n/a' })).toBe(true);
  });

  it('returns null for division by zero', () => {
    expect(run('1 / 0')).toBe(null);
    expect(run('5 % 0')).toBe(null);
    expect(run('7.5 % 2')).toBe(1.5);
    expect(run('-7 % 2')).toBe(-1);
  });
});

describe('evaluation: text', () => {
  it('handles the text functions', () => {
    expect(run("proper('hello wORLD-x')")).toBe('Hello World-X');
    expect(run("trim('  a  ')")).toBe('a');
    expect(run("left('abcdef', 2) ~~ right('abcdef', 2)")).toBe('abef');
    expect(run("substr('hello', 2, 3)")).toBe('ell');
    expect(run("substr('hello', 0, 3)")).toBe('he');
    expect(run("index_of('hello', 'l')")).toBe(3);
    expect(run("replace('a.b.c', '.', '-')")).toBe('a-b-c');
    expect(run("contains('Storm Damage', 'damage')")).toBe(true);
    expect(run("pad_left('7', 3, '0')")).toBe('007');
    expect(run("pad_left('1234', 3, '0')")).toBe('1234');
    expect(run("split_part('a,b,c', ',', -1)")).toBe('c');
    expect(run('format_number(1234567.891, 2)')).toBe('1,234,567.89');
    expect(run('format_number(-0.004, 2)')).toBe('0.00');
    expect(run("length('héllo')")).toBe(5);
  });

  it('prints numbers the way Postgres does', () => {
    expect(run("text(0.1 + 0.2)")).toBe('0.30000000000000004');
    expect(run('text(1e15)')).toBe('1e+15');
    expect(run('text(0.00001)')).toBe('1e-05');
    expect(run('text(5)')).toBe('5');
  });
});

describe('evaluation: math', () => {
  it('rounds half away from zero, at 15 significant digits', () => {
    expect(run('round(2.5)')).toBe(3);
    expect(run('round(-2.5)')).toBe(-3);
    expect(run('round(1.005, 2)')).toBe(1.01);
    expect(run('round(1234.5, -2)')).toBe(1200);
  });

  it('guards the functions Postgres would raise on', () => {
    expect(run('sqrt(-1)')).toBe(null);
    expect(run('ln(0)')).toBe(null);
    expect(run('power(-8, 0.5)')).toBe(null);
    expect(run('power(2, 10)')).toBe(1024);
  });

  it('min and max skip empty values', () => {
    expect(run('min(3, {{acres}}, 1)', {})).toBe(1);
    expect(run('max({{acres}}, 2)', { acres: 9 })).toBe(9);
  });
});

describe('evaluation: dates', () => {
  it('reads, adds and differences dates in UTC', () => {
    expect(run("date_add({{sampled}}, 1, 'years')", { sampled: '2024-02-29' })).toBe('2025-02-28');
    expect(run("date_add({{sampled}}, 1, 'months')", { sampled: '2024-01-31' })).toBe('2024-02-29');
    expect(run("date_add({{sampled}}, 36, 'hours')", { sampled: '2024-01-31' })).toBe('2024-02-01T12:00:00Z');
    expect(run("date_diff('2024-03-01', '2024-01-31', 'months')")).toBe(1);
    expect(run("date_diff('2024-01-30', '2024-03-01', 'months')")).toBe(-1);
    expect(run("date_diff('2024-03-01', '2024-02-01', 'days')")).toBe(29);
    expect(run("date_diff(today(), '2020-11-24', 'years')")).toBe(5);
  });

  it('honours offsets and treats text without one as UTC', () => {
    expect(run("text(to_date('2024-05-01T10:00:00+02:00'))")).toBe('2024-05-01T08:00:00Z');
    expect(run("text(to_date('2024-05-01 10:00'))")).toBe('2024-05-01T10:00:00Z');
    expect(run("to_date('not a date')")).toBe(null);
    expect(run("to_date('2024-02-30')")).toBe(null);
  });

  it('extracts parts and formats', () => {
    expect(run("weekday('2026-11-23')")).toBe(1);
    expect(run("week('2021-01-03')")).toBe(53);
    expect(run("day_of_year('2024-12-31')")).toBe(366);
    expect(run("format_date('2024-07-04T15:05:00Z', 'dddd, MMMM D, YYYY [at] h:mm A')")).toBe('Thursday, July 4, 2024 at 3:05 PM');
    expect(run("text(start_of('2026-11-26', 'weeks'))")).toBe('2026-11-23');
  });

  it('compares dates as instants, not as text', () => {
    expect(run("{{sampled}} > '2024-05-01T09:00:00Z'", { sampled: '2024-05-01T10:00:00+00:30' })).toBe(true);
  });

  it('uses the time zone for today()', () => {
    // 18:30 UTC on Nov 23 is still Nov 23 in Los Angeles, but Nov 24 in Tokyo.
    expect(run('text(today())', {}, { timeZone: 'America/Los_Angeles' })).toBe('2026-11-23');
    expect(run('text(today())', {}, { timeZone: 'Asia/Tokyo' })).toBe('2026-11-24');
  });
});

describe('evaluation: lists', () => {
  it('supports membership, counting and joining', () => {
    const p = { tags: ['oak', 'pine'] };
    expect(run("'oak' in {{tags}}", p)).toBe(true);
    expect(run("contains({{tags}}, 'fir')", p)).toBe(false);
    expect(run('count({{tags}})', p)).toBe(2);
    expect(run("join({{tags}}, '/')", p)).toBe('oak/pine');
    expect(run("any_of({{tags}}, 'fir', 'pine')", p)).toBe(true);
    expect(run("all_of({{tags}}, 'fir', 'pine')", p)).toBe(false);
    expect(run("{{tags}} == 'oak'", { tags: ['oak'] })).toBe(true);
  });
});

describe('evaluation: geometry', () => {
  const square = {
    type: 'Polygon',
    coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]],
  };
  it('measures area on the ellipsoid and perimeter on the sphere', () => {
    const acres = run("area($feature, 'acres')", {}, { geometry: square }) as number;
    expect(acres).toBeGreaterThan(303.5);
    expect(acres).toBeLessThan(305);
    const km = run("length($feature, 'kilometers')", {}, { geometry: square }) as number;
    expect(km).toBeCloseTo(4.448, 2);
    expect(run('round(x($feature), 3)', {}, { geometry: square })).toBe(0.005);
    expect(run('geometry_type($feature)', {}, { geometry: square })).toBe('Polygon');
  });
});

describe('SQL compiler', () => {
  const compile = (src: string, predicate = false) =>
    compileExpressionSql(src, { fields: SCHEMA, row: { propertiesSql: 'p' }, paramOffset: 2, predicate });

  it('binds text and numbers floats', () => {
    const c = compile("{{owner}} == 'x' and {{acres}} / 2 > 1");
    expect(c.params).toEqual(['x']);
    expect(c.sql).toContain('$3::text');
    expect(c.sql).toContain('(2::double precision)');
    expect(c.sql).toContain('NULLIF');
  });

  it('leaves bare comparisons in predicate position', () => {
    expect(compile("{{owner}} == 'x'", true).sql).toBe("((p->>'owner') = $3::text)");
    expect(compile("{{owner}} == 'x'").sql).toBe("COALESCE(((p->>'owner') = $3::text), FALSE)");
  });

  it('refuses to compile an expression with errors', () => {
    expect(() => compile('{{nope}}')).toThrow(ExpressionError);
  });
});

describe('older entry points', () => {
  it('evaluateExpression reads every field as untyped text', () => {
    expect(evaluateExpression(parseExpression('{{n}} > 9'), { n: '12' })).toBe(true);
    expect(evaluateExpression(parseExpression("{{d}} > '2020-12-31'"), { d: '2021-06-01' })).toBe(true);
  });
});

describe('catalog', () => {
  it('documents every function', () => {
    for (const f of FUNCTIONS) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.variants.length).toBeGreaterThan(0);
    }
  });
});

describe('SQL-safe field names (SEC-expr-field-allowlist)', () => {
  it('accepts identifier-shaped names and rejects the rest', () => {
    expect(isSqlSafeFieldName('acres')).toBe(true);
    expect(isSqlSafeFieldName('Owner Name')).toBe(false);
    expect(isSqlSafeFieldName("Owner's")).toBe(false);
    expect(isSqlSafeFieldName('__proto__')).toBe(false);
  });

  it('slugifies CSV headers with collision suffixes', () => {
    const used = new Set<string>();
    expect(toSqlSafeFieldName('Owner Name', used)).toBe('Owner_Name');
    expect(toSqlSafeFieldName('Owner Name', used)).toBe('Owner_Name_2');
    expect(toSqlSafeFieldName('constructor')).toBe('f_constructor');
  });

  it('refuses non-allowlisted refs at parse time, in every spelling', () => {
    expect(() => parseExpression("{{Owner Name}} == 'x'")).toThrow(ExpressionError);
    expect(() => parseExpression("$feature['bad name']")).toThrow(ExpressionError);
  });
});
