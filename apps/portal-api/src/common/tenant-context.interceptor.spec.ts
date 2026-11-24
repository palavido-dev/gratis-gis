// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The tenant context seen by real route handlers, through the real
// global guard (JwtAuthGuard) and the real interceptor, plus the two
// realtime WebSocket gateways, which read frames off the raw socket
// and set the context themselves.
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Controller, Get, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Observable } from 'rxjs';

import { ApiKeyService } from '../auth/api-key.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PrintReadCredentialService } from '../auth/print-read-credential.service.js';
import { Public } from '../auth/public.decorator.js';
import { DrawingsCollabGateway } from '../realtime/drawings-collab.gateway.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import { currentTenant, type TenantContext } from './tenant-context.js';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const KEY_A = 'ggk_' + 'a'.repeat(43);
const KEY_B = 'ggk_' + 'b'.repeat(43);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function userFor(orgId: string, id: string) {
  return {
    id,
    orgId,
    orgSlug: 'org',
    username: id,
    email: `${id}@example.org`,
    orgRole: 'viewer',
    groupIds: [],
    capabilities: new Set(),
    authKind: 'api_key',
    apiKeyReadOnly: false,
  };
}

@Controller('t')
class ProbeController {
  @Get('authed')
  async authed(): Promise<{
    first: TenantContext | undefined;
    later: TenantContext | undefined;
  }> {
    const first = currentTenant();
    await sleep(15);
    const later = await new Promise<TenantContext | undefined>((resolve) =>
      setTimeout(() => resolve(currentTenant()), 1),
    );
    return { first, later };
  }

  @Public()
  @Get('public')
  async open(): Promise<{ ctx: TenantContext | undefined }> {
    await sleep(1);
    return { ctx: currentTenant() };
  }

  @Get('stream')
  stream(): Observable<{ ctx: TenantContext | undefined }> {
    // The value is produced later, inside the subscription.
    return new Observable((sub) => {
      setTimeout(() => {
        sub.next({ ctx: currentTenant() });
        sub.complete();
      }, 5);
    });
  }
}

describe('TenantContextInterceptor over HTTP', () => {
  let app: INestApplication;
  let port: number;
  const guardSaw: Array<TenantContext | undefined> = [];

  const apiKeys = {
    resolve: jest.fn(async (token: string) => {
      guardSaw.push(currentTenant());
      await sleep(1);
      if (token === KEY_A) return userFor(ORG_A, 'user-a');
      if (token === KEY_B) return userFor(ORG_B, 'user-b');
      throw new UnauthorizedException();
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: ApiKeyService, useValue: apiKeys },
        { provide: PrintReadCredentialService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    guardSaw.length = 0;
  });

  function get(path: string, token?: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: token ? { authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('runs an authed handler as the caller org, with the user id', async () => {
    const res = await get('/t/authed', KEY_A);
    expect(res.status).toBe(200);
    const want = { kind: 'org', orgId: ORG_A, userId: 'user-a' };
    expect(res.body).toEqual({ first: want, later: want });
  });

  it('runs a @Public handler with no caller as anonymous', async () => {
    const res = await get('/t/public');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ctx: { kind: 'anonymous' } });
  });

  it('runs a @Public handler with a signed-in caller as that org', async () => {
    const res = await get('/t/public', KEY_B);
    expect(res.body).toEqual({
      ctx: { kind: 'org', orgId: ORG_B, userId: 'user-b' },
    });
  });

  it('covers a handler that returns an observable', async () => {
    const res = await get('/t/stream', KEY_B);
    expect(res.body).toEqual({
      ctx: { kind: 'org', orgId: ORG_B, userId: 'user-b' },
    });
  });

  it('keeps concurrent requests from different orgs apart', async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      get('/t/authed', i % 2 === 0 ? KEY_A : KEY_B),
    );
    const results = await Promise.all(calls);
    results.forEach((res, i) => {
      const org = i % 2 === 0 ? ORG_A : ORG_B;
      const body = res.body as { first: TenantContext; later: TenantContext };
      expect(body.first).toMatchObject({ kind: 'org', orgId: org });
      expect(body.later).toMatchObject({ kind: 'org', orgId: org });
    });
  });

  it('resolves the caller inside the guard as system work', async () => {
    await get('/t/authed', KEY_A);
    expect(guardSaw).toEqual([{ kind: 'system', reason: 'auth-sync' }]);
  });
});

/** Just enough of a `ws` socket for the gateways. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {
    this.readyState = 3;
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('tenant context in the realtime gateways', () => {
  it('runs presence join, frames and leave as the socket owner org', async () => {
    const seen: Array<[string, TenantContext | undefined]> = [];
    const realtime = {
      consumeTicket: () => ({
        user: userFor(ORG_A, 'user-a'),
        connectionId: 'c1',
      }),
      subscribe: () => () => undefined,
      heartbeat: jest.fn(async () => {
        await sleep(1);
        seen.push(['heartbeat', currentTenant()]);
        return { members: [] };
      }),
      leave: jest.fn(async () => {
        seen.push(['leave', currentTenant()]);
      }),
    };
    const gateway = new RealtimeGateway(realtime as never);
    const socket = new FakeSocket();
    await gateway.handleConnection(socket as never, {
      url: '/api/realtime/ws?mapId=m1&ticket=t1',
    });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat' })));
    await sleep(5);
    gateway.handleDisconnect(socket as never);
    await flush();
    const want = { kind: 'org', orgId: ORG_A, userId: 'user-a' };
    expect(seen).toEqual([
      ['heartbeat', want],
      ['heartbeat', want],
      ['leave', want],
    ]);
    expect(currentTenant()).toBeUndefined();
  });

  it('runs drawings join, updates and leave as the socket owner org', async () => {
    const seen: Array<[string, TenantContext | undefined]> = [];
    const collab = {
      consumeTicket: () => ({ user: userFor(ORG_B, 'user-b') }),
      join: jest.fn(async () => {
        await sleep(1);
        seen.push(['join', currentTenant()]);
        return { connectionId: 'c2' };
      }),
      applyUpdate: jest.fn(() => {
        seen.push(['update', currentTenant()]);
      }),
      leave: jest.fn(() => {
        seen.push(['leave', currentTenant()]);
      }),
    };
    const gateway = new DrawingsCollabGateway(collab as never);
    const socket = new FakeSocket();
    await gateway.handleConnection(socket as never, {
      url: '/api/realtime/drawings-ws?mapId=m1&drawingSetId=d1&ticket=t1',
    });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'update', update: 'AA==' })));
    await flush();
    gateway.handleDisconnect(socket as never);
    const want = { kind: 'org', orgId: ORG_B, userId: 'user-b' };
    expect(seen).toEqual([
      ['join', want],
      ['update', want],
      ['leave', want],
    ]);
  });
});
