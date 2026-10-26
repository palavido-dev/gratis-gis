// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  detectUsStateGeomatch,
  planUsStateGeomatch,
} from './csv-geomatch.js';

describe('planUsStateGeomatch', () => {
  it('detects a State column of full names', () => {
    const plan = planUsStateGeomatch(
      'State,Population\nCalifornia,39500000\nTexas,29000000\n',
    );
    expect(plan.kind).toBe('us-states');
    if (plan.kind !== 'us-states') return;
    expect(plan.column).toBe('State');
    expect(plan.rows).toHaveLength(2);
  });

  it('detects two-letter abbreviations', () => {
    const plan = planUsStateGeomatch('st,pop\nCA,1\nNY,2\nWA,3\n');
    expect(plan.kind).toBe('us-states');
  });

  it('leaves a coordinate file alone', () => {
    const plan = planUsStateGeomatch(
      'lat,lng,state\n38.9,-77.0,VA\n',
    );
    expect(plan.kind).toBe('none');
  });

  it('rejects a state-named column of junk values', () => {
    const plan = planUsStateGeomatch(
      'state,name\napple,Desk\nbanana,Lamp\n',
    );
    expect(plan.kind).toBe('none');
  });
});

describe('detectUsStateGeomatch', () => {
  it('joins population rows to state polygons', () => {
    const result = detectUsStateGeomatch(
      'State,Population\nCalifornia,39500000\nUnknownland,1\nTexas,29000000\n',
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(1);
    expect(result.geojson.features).toHaveLength(2);
    expect(result.geojson.features[0]?.geometry.type).toMatch(/Polygon/);
    expect(result.geojson.features[0]?.properties.Population).toBe(39500000);
    expect(result.geojson.features[0]?.properties.state_abbr).toBe('CA');
  });

  it('drops forged __proto__ headers instead of polluting Object', () => {
    const result = detectUsStateGeomatch(
      'State,__proto__\nCalifornia,polluted\n',
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(Object.prototype.hasOwnProperty.call(
      result.geojson.features[0]?.properties ?? {},
      '__proto__',
    )).toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
