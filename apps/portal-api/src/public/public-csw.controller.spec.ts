// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

import { PublicCswController } from './public-csw.controller.js';

/**
 * CSW KVP names are case-insensitive. Harvesters send SERVICE,
 * REQUEST, startPosition and maxRecords; the controller used to read
 * only the all-lower-case spellings, so paging never advanced.
 */
function make() {
  const findMany = jest.fn(async () => []);
  const prisma = { item: { count: jest.fn(async () => 120), findMany } };
  return { c: new PublicCswController(prisma as never), findMany };
}

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  return { query, headers: { host: 'portal.test', ...headers }, protocol: 'https' } as never;
}

describe('PublicCswController', () => {
  const saved = process.env.PORTAL_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = saved;
  });

  it('reads standard camel-case paging parameters', async () => {
    const { c, findMany } = make();
    await c.dispatch(
      req({ SERVICE: 'CSW', REQUEST: 'GetRecords', startPosition: '51', maxRecords: '50' }),
    );
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50 }));
  });

  it('answers GetCapabilities with upper-case keys', async () => {
    const { c } = make();
    const xml = await c.dispatch(req({ SERVICE: 'CSW', REQUEST: 'GetCapabilities' }));
    expect(xml).toContain('<csw:Capabilities');
  });

  it('builds endpoints from PORTAL_BASE_URL, not request headers', async () => {
    process.env.PORTAL_BASE_URL = 'https://gis.example.org';
    const { c } = make();
    const xml = await c.dispatch(
      req({ service: 'CSW', request: 'GetCapabilities' }, { 'x-forwarded-host': 'evil.example' }),
    );
    expect(xml).toContain('https://gis.example.org/api/public/csw');
    expect(xml).not.toContain('evil.example');
  });
});
