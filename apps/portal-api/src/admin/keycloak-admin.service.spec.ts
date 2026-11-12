// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadGatewayException, ConflictException } from '@nestjs/common';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { SystemSettingsService } from '../notifications/system-settings.service.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';

describe('KeycloakAdminService.createUser error mapping', () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  let svc: KeycloakAdminService;

  beforeEach(() => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'portal-api-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    svc = new KeycloakAdminService(
      {} as SystemSettingsService,
      {} as LeaderElectionService,
    );
    // Skip the client_credentials round trip.
    (svc as unknown as { tokenCache: unknown }).tokenCache = {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...env };
  });

  function respondWith(status: number, statusText: string): jest.Mock {
    const mock = jest.fn(
      async () => new Response('{"errorMessage":"x"}', { status, statusText }),
    );
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  const input = { username: 'ana', email: 'ana@example.org' };

  it('maps a Keycloak 409 to ConflictException (HTTP 409)', async () => {
    respondWith(409, 'Conflict');
    const err = await svc.createUser(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    // The Keycloak body can echo the address; it must not leak.
    expect((err as Error).message).not.toContain('ana@example.org');
  });

  it('keeps other Keycloak failures as BadGatewayException (HTTP 502)', async () => {
    respondWith(500, 'Internal Server Error');
    const err = await svc.createUser(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as BadGatewayException).getStatus()).toBe(502);
  });
});

describe('KeycloakAdminService.updateUser email change', () => {
  const realFetch = globalThis.fetch;
  let svc: KeycloakAdminService;
  let puts: Array<Record<string, unknown>>;

  beforeEach(() => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'portal-api-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    svc = new KeycloakAdminService(
      {} as SystemSettingsService,
      {} as LeaderElectionService,
    );
    (svc as unknown as { tokenCache: unknown }).tokenCache = {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
    };
    puts = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          id: 'u1',
          username: 'ana',
          email: 'ana@example.org',
          enabled: true,
          emailVerified: true,
          requiredActions: ['CONFIGURE_TOTP'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('clears emailVerified and asks for verification on a new address', async () => {
    await svc.updateUser('u1', { email: 'new@example.org' });
    expect(puts[0]).toMatchObject({
      email: 'new@example.org',
      emailVerified: false,
      requiredActions: ['CONFIGURE_TOTP', 'VERIFY_EMAIL'],
    });
  });

  it('leaves verification alone when the address does not change', async () => {
    await svc.updateUser('u1', { email: 'ANA@example.org', firstName: 'Ana' });
    expect(puts[0]?.emailVerified).toBeUndefined();
    expect(puts[0]?.requiredActions).toBeUndefined();
  });
});

describe('KeycloakAdminService.setMfaRequired reaches existing accounts', () => {
  const realFetch = globalThis.fetch;
  let svc: KeycloakAdminService;
  let userPuts: Array<{ url: string; body: Record<string, unknown> }>;

  const users = [
    { id: 'u-new', username: 'ana', enabled: true, requiredActions: [] },
    { id: 'u-otp', username: 'ben', enabled: true, requiredActions: [] },
    { id: 'u-pend', username: 'cy', enabled: true, requiredActions: ['CONFIGURE_TOTP'] },
    { id: 'u-svc', username: 'service-account-portal-api-admin', enabled: true },
  ];

  beforeEach(() => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'portal-api-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    svc = new KeycloakAdminService(
      {} as SystemSettingsService,
      {} as LeaderElectionService,
    );
    (svc as unknown as { tokenCache: unknown }).tokenCache = {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
    };
    userPuts = [];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/authentication/required-actions')) {
        return json([{ alias: 'CONFIGURE_TOTP', defaultAction: false }]);
      }
      if (url.endsWith('/authentication/required-actions/CONFIGURE_TOTP')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/users?')) return json(users);
      const cred = /\/users\/([^/]+)\/credentials$/.exec(url);
      if (cred) return json(cred[1] === 'u-otp' ? [{ type: 'otp' }] : [{ type: 'password' }]);
      if (init?.method === 'PUT' && /\/users\/[^/?]+$/.test(url)) {
        userPuts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(null, { status: 204 });
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('turning it on asks every account without an authenticator', async () => {
    await svc.setMfaRequired(true);
    expect(userPuts).toEqual([
      {
        url: expect.stringMatching(/\/users\/u-new$/),
        body: { requiredActions: ['CONFIGURE_TOTP'] },
      },
    ]);
  });

  it('turning it off removes a still pending request', async () => {
    await svc.setMfaRequired(false);
    expect(userPuts).toEqual([
      { url: expect.stringMatching(/\/users\/u-pend$/), body: { requiredActions: [] } },
    ]);
  });
});

describe('KeycloakAdminService.listServiceAccountUsernames', () => {
  const realFetch = globalThis.fetch;
  let svc: KeycloakAdminService;
  let urls: string[];

  beforeEach(() => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'portal-api-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    svc = new KeycloakAdminService(
      {} as SystemSettingsService,
      {} as LeaderElectionService,
    );
    (svc as unknown as { tokenCache: unknown }).tokenCache = {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
    };
    urls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(routes: Record<string, { status: number; body: unknown }>): void {
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      const r = key ? routes[key]! : { status: 404, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
  }

  it('returns the lowercased service-account usernames of clients that have them', async () => {
    serve({
      '/clients?': {
        status: 200,
        body: [
          { id: 'c-admin', serviceAccountsEnabled: true },
          { id: 'c-web', serviceAccountsEnabled: false },
          { id: 'c-report' },
        ],
      },
      '/clients/c-admin/service-account-user': {
        status: 200,
        body: { id: 'u-1', username: 'Service-Account-Portal-API-Admin' },
      },
    });
    const names = await svc.listServiceAccountUsernames();
    expect([...names]).toEqual(['service-account-portal-api-admin']);
    // Only the client with service accounts enabled is looked up.
    expect(urls.filter((u) => u.includes('/service-account-user'))).toHaveLength(1);
  });

  it('throws when Keycloak cannot list clients, so callers can stop', async () => {
    serve({ '/clients?': { status: 503, body: {} } });
    await expect(svc.listServiceAccountUsernames()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('throws when a service-account lookup fails, rather than returning a partial set', async () => {
    serve({
      '/clients?': { status: 200, body: [{ id: 'c-admin', serviceAccountsEnabled: true }] },
      '/clients/c-admin/service-account-user': { status: 500, body: {} },
    });
    await expect(svc.listServiceAccountUsernames()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('KeycloakAdminService.ensureQgisRedirects', () => {
  const realFetch = globalThis.fetch;
  let svc: KeycloakAdminService;
  let calls: Array<{ url: string; method: string }>;

  beforeEach(() => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'portal-api-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    svc = new KeycloakAdminService(
      {} as SystemSettingsService,
      {} as LeaderElectionService,
    );
    (svc as unknown as { tokenCache: unknown }).tokenCache = {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
    };
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(putStatus: number, listStatus = 200): void {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.includes('/clients?clientId=qgis-plugin')) {
        return new Response(JSON.stringify([{ id: 'q1' }]), { status: listStatus });
      }
      if (method === 'PUT') {
        return new Response(putStatus === 204 ? null : '{}', { status: putStatus });
      }
      return new Response(
        JSON.stringify({ redirectUris: ['http://127.0.0.1*'] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  }

  it('writes the tightened list when the account may manage clients', async () => {
    serve(204);
    await svc.ensureQgisRedirects();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('skips without throwing when Keycloak answers 403 to the update', async () => {
    serve(403);
    await expect(svc.ensureQgisRedirects()).resolves.toBeUndefined();
  });

  it('skips without throwing when the account cannot even list clients', async () => {
    serve(204, 403);
    await expect(svc.ensureQgisRedirects()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('still reports other failures', async () => {
    serve(500);
    await expect(svc.ensureQgisRedirects()).rejects.toThrow(/500/);
  });
});

describe('KeycloakAdminService user paths', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('encodes the user id so it cannot leave /users/', async () => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'portal-api-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    const svc = new KeycloakAdminService({} as SystemSettingsService, {} as LeaderElectionService);
    (svc as unknown as { tokenCache: unknown }).tokenCache = {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
    };
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    await svc.getUser('../clients').catch(() => undefined);
    expect(urls[0]).toMatch(/\/users\/\.\.%2Fclients$/);
  });
});
