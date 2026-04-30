import { BadRequestException } from '@nestjs/common';

import { fishnetGenerator } from './fishnet.js';

describe('fishnetGenerator.validate', () => {
  it('accepts a basic polygons-mode params shape', () => {
    expect(
      fishnetGenerator.validate({
        cellSize: 100,
        unit: 'meters',
        output: 'polygons',
      }),
    ).toEqual({ cellSize: 100, unit: 'meters', output: 'polygons' });
  });

  it('accepts lines mode', () => {
    expect(
      fishnetGenerator.validate({
        cellSize: 50,
        unit: 'meters',
        output: 'lines',
      }),
    ).toEqual({ cellSize: 50, unit: 'meters', output: 'lines' });
  });

  it('defaults unit to meters and output to polygons', () => {
    expect(fishnetGenerator.validate({ cellSize: 100 })).toEqual({
      cellSize: 100,
      unit: 'meters',
      output: 'polygons',
    });
  });

  it('rejects non-finite cellSize', () => {
    expect(() => fishnetGenerator.validate({ cellSize: NaN })).toThrow(
      /finite number/,
    );
  });

  it('rejects below the minimum', () => {
    expect(() => fishnetGenerator.validate({ cellSize: 0.5 })).toThrow(
      /at least 1 meter/,
    );
  });

  it('rejects above the meters ceiling, including unit-converted', () => {
    expect(() =>
      fishnetGenerator.validate({ cellSize: 1_000_000, unit: 'meters' }),
    ).toThrow(/must not exceed/);
    expect(() =>
      fishnetGenerator.validate({ cellSize: 1000, unit: 'kilometers' }),
    ).toThrow(/must not exceed/);
  });

  it('rejects non-objects', () => {
    expect(() => fishnetGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => fishnetGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('fishnetGenerator.outputSchema', () => {
  it('drops source attributes and emits cell_row + cell_col', () => {
    const out = fishnetGenerator.outputSchema(
      [
        { name: 'name', label: 'Name', type: 'string', nullable: false },
        { name: 'pop', label: 'Pop', type: 'number', nullable: true },
      ],
      { cellSize: 100, unit: 'meters', output: 'polygons' },
    );
    expect(out).toEqual([
      { name: 'cell_row', label: 'Row', type: 'number', nullable: false },
      { name: 'cell_col', label: 'Column', type: 'number', nullable: false },
    ]);
  });
});

describe('fishnetGenerator.outwardReachMeters', () => {
  it('returns 0 (output stays inside input bbox)', () => {
    expect(
      fishnetGenerator.outwardReachMeters({
        cellSize: 100,
        unit: 'meters',
        output: 'polygons',
      }),
    ).toBe(0);
  });
});

describe('fishnetGenerator.toSql', () => {
  it('emits ST_SquareGrid + ST_Intersection in polygons mode', () => {
    const fragment = fishnetGenerator.toSql(
      'source',
      { cellSize: 100, unit: 'meters', output: 'polygons' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_SquareGrid\(\$1, source\.geom\)/);
    expect(fragment.sql).toMatch(/ST_Intersection\(grid\.geom, source\.geom\)/);
    // 100m / 111_320 m/deg ~= 0.000898 deg
    expect(fragment.params[0]).toBeCloseTo(0.000898, 6);
  });

  it('emits ST_Boundary clipping in lines mode', () => {
    const fragment = fishnetGenerator.toSql(
      'source',
      { cellSize: 100, unit: 'meters', output: 'lines' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_Boundary\(grid\.geom\)/);
    expect(fragment.sql).toMatch(/ST_Intersection\(/);
  });

  it('converts non-meter units before computing degrees', () => {
    const fragment = fishnetGenerator.toSql(
      'source',
      { cellSize: 1, unit: 'kilometers', output: 'polygons' },
      0,
    );
    // 1000m / 111_320 m/deg ~= 0.00898 deg
    expect(fragment.params[0]).toBeCloseTo(0.00898, 5);
  });

  it('emits cell_row + cell_col into the output properties JSONB', () => {
    const fragment = fishnetGenerator.toSql(
      'source',
      { cellSize: 100, unit: 'meters', output: 'polygons' },
      0,
    );
    expect(fragment.sql).toMatch(/jsonb_build_object\('cell_row'/);
    expect(fragment.sql).toMatch(/'cell_col'/);
  });

  it('preserves SRID 4326', () => {
    const fragment = fishnetGenerator.toSql(
      'source',
      { cellSize: 100, unit: 'meters', output: 'polygons' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
  });

  it('honors paramOffset', () => {
    const fragment = fishnetGenerator.toSql(
      'step_2',
      { cellSize: 100, unit: 'meters', output: 'polygons' },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
