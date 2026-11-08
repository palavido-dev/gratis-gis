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
