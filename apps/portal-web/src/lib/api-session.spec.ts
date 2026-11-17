// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * apiFetch treats every session error as signed out, the same rule
 * the BFF applies. It used to check only RefreshAccessTokenError, so
 * an idle-timed-out session forwarded its dead bearer and 401'd into
 * the error boundary instead of redirecting to sign-in.
 */
const getServerSession = jest.fn();
const redirect = jest.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});

jest.mock('next-auth', () => ({ getServerSession: () => getServerSession() }));
jest.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

import { apiFetch } from './api';

afterEach(() => jest.restoreAllMocks());

describe('apiFetch session check', () => {
  it.each(['RefreshAccessTokenError', 'IdleTimeout'])(
    'redirects to sign-in on %s without calling the API',
    async (error) => {
      getServerSession.mockResolvedValue({ accessToken: 'dead', error });
      const fetchMock = jest.spyOn(globalThis, 'fetch');
      await expect(apiFetch('/api/items')).rejects.toThrow('redirect:/signin');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('forwards a usable session', async () => {
    getServerSession.mockResolvedValue({ accessToken: 'live' });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    await expect(apiFetch('/api/items')).resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer live');
  });
});
