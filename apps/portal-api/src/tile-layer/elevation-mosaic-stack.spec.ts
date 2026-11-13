// SPDX-License-Identifier: AGPL-3.0-or-later
import { ElevationMosaicService } from './elevation-mosaic.service.js';

/**
 * Every elevation mosaic tile resolved its whole stack (up to 8 item
 * reads, in series) before reaching the tile cache. A view of about
 * 30 tiles shares one resolution now, per viewer, for a few seconds.
 */
describe('elevation mosaic stack resolution', () => {
  function setup(fail = false) {
    const resolveDemSource = jest.fn(async (_user: unknown, id: string) => {
      if (fail) throw new Error('db down');
      if (id === 'hidden') throw Object.assign(new Error('no'), { status: 403 });
      return { storageKey: `item-tile-layer/${id}` };
    });
    const svc = new ElevationMosaicService(
      { resolveDemSource } as never,
      {} as never,
      {} as never,
    );
    const resolve = (user: unknown, ids: string[]) =>
      (
        svc as unknown as {
          resolveStack(u: unknown, i: string[]): Promise<Array<{ itemId: string }>>;
        }
      ).resolveStack(user, ids);
    return { resolveDemSource, resolve };
  }

  it('shares one resolution across a burst of tiles for the same viewer', async () => {
    const { resolveDemSource, resolve } = setup();
    const user = { id: 'u1' };
    const results = await Promise.all(
      Array.from({ length: 30 }, () => resolve(user, ['a', 'hidden', 'b'])),
    );
    expect(resolveDemSource).toHaveBeenCalledTimes(3);
    expect(results[29]!.map((e) => e.itemId)).toEqual(['a', 'b']);
  });

  it('keeps viewers apart', async () => {
    const { resolveDemSource, resolve } = setup();
    await resolve({ id: 'u1' }, ['a']);
    await resolve({ id: 'u2' }, ['a']);
    await resolve(null, ['a']);
    expect(resolveDemSource).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed resolution', async () => {
    const { resolveDemSource, resolve } = setup(true);
    await expect(resolve({ id: 'u1' }, ['a'])).rejects.toThrow('db down');
    await expect(resolve({ id: 'u1' }, ['a'])).rejects.toThrow('db down');
    expect(resolveDemSource).toHaveBeenCalledTimes(2);
  });
});
