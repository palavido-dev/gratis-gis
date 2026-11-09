// SPDX-License-Identifier: AGPL-3.0-or-later
import { PrintRenderService } from './print-render.service.js';

/**
 * The print preview loads the template, map, and basemap as the user
 * who asked for the print. That user has to be the same principal
 * every other path builds: a deleted user gets nothing, and groups in
 * the trash grant nothing.
 */
describe('PrintRenderService.loadJobByToken principal', () => {
  function serviceWith(principal: unknown) {
    const get = jest.fn(async (_user: unknown, id: string) => ({
      id,
      title: id,
      type: id === 'map-1' ? 'map' : 'print_template',
      data: {},
    }));
    const prisma = {
      printRenderToken: {
        delete: async () => ({
          userId: 'u1',
          templateId: 'tpl-1',
          mapId: 'map-1',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      user: {
        findUnique: async () => ({ id: 'u1', fullName: 'Pat', username: 'pat' }),
      },
    };
    const authSync = { principalForUserId: jest.fn(async () => principal) };
    const svc = new PrintRenderService(
      prisma as never,
      { get } as never,
      authSync as never,
    );
    return { svc, get, authSync };
  }

  it('refuses a user the principal builder rejects (deleted)', async () => {
    const { svc, get } = serviceWith(null);
    await expect(svc.loadJobByToken('t')).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the items as the shared principal', async () => {
    const principal = { id: 'u1', orgId: 'o1', orgSlug: 'acme', groupIds: ['g-live'] };
    const { svc, get, authSync } = serviceWith(principal);
    const bundle = await svc.loadJobByToken('t');
    expect(authSync.principalForUserId).toHaveBeenCalledWith('u1');
    expect(bundle?.userDisplayName).toBe('Pat');
    expect(get.mock.calls.every(([user]) => user === principal)).toBe(true);
  });
});
