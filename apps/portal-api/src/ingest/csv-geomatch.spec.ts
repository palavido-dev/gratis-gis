// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  detectUsGeomatch,
  planCountryGeomatch,
  planUsCountyGeomatch,
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

  it('defers when a County column is present', () => {
    const plan = planUsStateGeomatch(
      'County,State,Pop\nTravis,TX,1\nKing,WA,2\n',
    );
    expect(plan.kind).toBe('none');
  });
});

describe('planUsCountyGeomatch', () => {
  it('detects County + State columns', () => {
    const plan = planUsCountyGeomatch(
      'County,State,Pop\nTravis,TX,100\nKing,WA,200\n',
    );
    expect(plan.kind).toBe('us-counties');
    if (plan.kind !== 'us-counties') return;
    expect(plan.column).toBe('County');
    expect(plan.stateColumnIndex).not.toBeNull();
  });

  it('accepts "County, ST" composite cells without a state column', () => {
    const plan = planUsCountyGeomatch(
      'County,Pop\n"Travis, TX",1\n"King, WA",2\n"Los Angeles, CA",3\n',
    );
    expect(plan.kind).toBe('us-counties');
  });

  it('rejects ambiguous bare county names without state', () => {
    // Washington County exists in many states — unique-name map must miss.
    const plan = planUsCountyGeomatch(
      'County,Pop\nWashington,1\nWashington,2\nWashington,3\n',
    );
    expect(plan.kind).toBe('none');
  });
});

describe('planCountryGeomatch', () => {
  it('detects a Country column of names and ISO codes', () => {
    const plan = planCountryGeomatch(
      'Country,Pop\nFrance,1\nDE,2\nUSA,3\n',
    );
    expect(plan.kind).toBe('countries');
  });

  it('defers when a County column is present', () => {
    const plan = planCountryGeomatch(
      'County,Country,Pop\nTravis,USA,1\n',
    );
    expect(plan.kind).toBe('none');
  });
});

describe('detectUsGeomatch', () => {
  it('joins population rows to state polygons', () => {
    const result = detectUsGeomatch(
      'State,Population\nCalifornia,39500000\nUnknownland,1\nTexas,29000000\n',
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.boundary).toBe('us-states');
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(1);
    expect(result.geojson.features).toHaveLength(2);
    expect(result.geojson.features[0]?.geometry.type).toMatch(/Polygon/);
    expect(result.geojson.features[0]?.properties.Population).toBe(39500000);
    expect(result.geojson.features[0]?.properties.state_abbr).toBe('CA');
  });

  it('joins county rows with state disambiguation', () => {
    const result = detectUsGeomatch(
      'County,State,Population\nTravis,TX,100\nKing,WA,200\nNowhere,ZZ,1\n',
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.boundary).toBe('us-counties');
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(1);
    expect(result.geojson.features[0]?.properties.county_name).toBe('Travis');
    expect(result.geojson.features[0]?.properties.state_abbr).toBe('TX');
    expect(result.geojson.features[0]?.properties.county_geoid).toMatch(/^\d{5}$/);
  });

  it('prefers counties over states when both columns exist', () => {
    const result = detectUsGeomatch(
      'County,State,Pop\nTravis,TX,1\n',
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.boundary).toBe('us-counties');
  });

  it('joins country rows by name and ISO alias', () => {
    const result = detectUsGeomatch(
      'Country,Pop\nFrance,10\nDE,20\nUnited States,30\nAtlantis,1\n',
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.boundary).toBe('countries');
    expect(result.matched).toBe(3);
    expect(result.unmatched).toBe(1);
    expect(result.geojson.features[0]?.properties.country_iso2).toBe('FR');
  });

  it('drops forged __proto__ headers instead of polluting Object', () => {
    const result = detectUsGeomatch(
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
