// SPDX-License-Identifier: AGPL-3.0-or-later
import { decodeSharedArea, encodeSharedArea } from './whats-here';

describe("What's Here share links (#796)", () => {
  it('round trips an area, its distance, place and breakdowns', async () => {
    const code = await encodeSharedArea({
      geometry: { type: 'Point', coordinates: [-79.8467391234, 38.9259871234] },
      distanceMeters: 152.4,
      place: 'Elkins, WV',
      breakdowns: { 'layer-1': 'zoning' },
    });
    expect(code).toMatch(/^[zj][A-Za-z0-9_-]+$/);
    const back = await decodeSharedArea(code!);
    expect(back).toEqual({
      geometry: { type: 'Point', coordinates: [-79.846739, 38.925987] },
      distanceMeters: 152.4,
      place: 'Elkins, WV',
      breakdowns: { 'layer-1': 'zoning' },
    });
  });

  it('leaves out an empty place and empty breakdowns', async () => {
    const code = await encodeSharedArea({
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      distanceMeters: 0,
      breakdowns: {},
    });
    expect(await decodeSharedArea(code!)).toEqual({
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      distanceMeters: 0,
    });
  });

  it('refuses an area too detailed for a link', async () => {
    // Random coordinates do not compress: about 40 bytes each.
    const ring = Array.from({ length: 5000 }, () => [Math.random() * 10, Math.random() * 10]);
    ring.push(ring[0]!);
    expect(
      await encodeSharedArea({ geometry: { type: 'Polygon', coordinates: [ring] }, distanceMeters: 0 }),
    ).toBeNull();
  });

  it.each(['', 'x123', 'jnot-json', `j${btoa('{"v":2,"g":{"type":"Point","coordinates":[0,0]}}')}`, `j${btoa('{"v":1,"g":{"type":"Feature"}}')}`])(
    'reads %p as no area',
    async (code) => {
      expect(await decodeSharedArea(code)).toBeNull();
    },
  );

  it('drops a negative distance and non-text breakdowns', async () => {
    const code = `j${btoa(JSON.stringify({ v: 1, g: { type: 'Point', coordinates: [1, 2] }, d: -5, b: { a: 3, c: 'f' } }))
      .replace(/=+$/, '')}`;
    expect(await decodeSharedArea(code)).toEqual({
      geometry: { type: 'Point', coordinates: [1, 2] },
      distanceMeters: 0,
      breakdowns: { c: 'f' },
    });
  });
});
