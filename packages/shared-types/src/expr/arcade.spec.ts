// SPDX-License-Identifier: AGPL-3.0-or-later
import { translateArcade } from './arcade';
import { analyzeExpression, evaluateExpressionValue } from '../expression';

const ok = (src: string) => {
  const r = translateArcade(src);
  if ('error' in r) throw new Error(r.error);
  return r.expression;
};

describe('translateArcade', () => {
  it('keeps what already means the same', () => {
    expect(ok('$feature.NAME + " " + $feature.TYPE')).toBe("$feature.NAME + ' ' + $feature.TYPE");
    expect(ok("return IIf($feature.acres > 5, 'Large', 'Small');")).toBe("iif($feature.acres > 5, 'Large', 'Small')");
    expect(ok("When($feature.p == 1, 'High', 'Low')")).toBe("when($feature.p == 1, 'High', 'Low')");
  });

  it('adjusts functions whose meaning differs', () => {
    const run = (src: string, properties: Record<string, unknown>) =>
      evaluateExpressionValue(ok(src), { fields: [], allowUnknownFields: true, properties });
    expect(run('Mid($feature.code, 1, 2)', { code: 'ABCD' })).toBe('BC');
    expect(run("Find('C', $feature.code)", { code: 'ABCD' })).toBe(2);
    expect(run("Find('Z', $feature.code)", { code: 'ABCD' })).toBe(-1);
    expect(run('Month($feature.d)', { d: '2024-01-15' })).toBe(0);
    expect(run('Weekday($feature.d)', { d: '2026-11-22' })).toBe(0); // a Sunday
    expect(run('Count($feature.code)', { code: 'ABCD' })).toBe(4);
    expect(run("Concatenate([$feature.a, $feature.b], '-')", { a: 'x', b: 'y' })).toBe('x-y');
    expect(run("Text($feature.n, '#,###.00')", { n: 1234.5 })).toBe('1,234.50');
    expect(run("Text($feature.d, 'MMM D, Y')", { d: '2024-07-04' })).toBe('Jul 4, 2024');
    expect(run('Upper($feature.a) + TextFormatting.NewLine + $feature.b', { a: 'x', b: 'y' })).toBe('X\ny');
  });

  it('translates the common FeatureSet shapes', () => {
    expect(ok("Count(FeatureSetByRelationshipName($feature, 'inspections'))")).toBe("count(related('inspections'))");
    expect(ok('Count(Intersects(FeatureSetByName($map, "Parcels"), $feature))')).toBe("count(intersecting(layer('Parcels')))");
    expect(ok("First(OrderBy(Filter(FeatureSetByName($datastore, 'Visits'), \"status = 'done' AND n > 2\"), 'visited DESC')).visited")).toBe(
      "first(order_by(filter(layer('Visits'), {{status}} = 'done' AND {{n}} > 2), {{visited}}, 'desc')).visited".replace(' = ', ' == '),
    );
    expect(ok("Sum(FeatureSetByRelationshipName($feature, 'repairs'), 'cost')")).toBe("sum(related('repairs'), {{cost}})");
  });

  it('refuses what it cannot carry, with a reason', () => {
    expect(translateArcade('var x = 1; return x')).toEqual({ error: expect.stringMatching(/variables/) });
    expect(translateArcade('for (var f in fs) { }')).toEqual({ error: expect.stringMatching(/variables|loop/) });
    expect(translateArcade("Filter(FeatureSetByName($map, 'X'), 'id = @id')")).toEqual({ error: expect.stringMatching(/@variable/) });
    expect(translateArcade("FeatureSetByPortalItem(Portal('https://x'), 'abc', 0)")).toEqual({ error: expect.stringMatching(/ArcGIS item/) });
  });

  it('produces expressions the checker accepts', () => {
    const r = analyzeExpression(ok("Round($feature.acres * 0.4047, 2)"), { fields: [{ name: 'acres', type: 'number' }] });
    expect(r.issues).toEqual([]);
  });
});
