// SPDX-License-Identifier: AGPL-3.0-or-later
import { ReadinessService } from './readiness.service.js';

function service(counts: { stuck: number; running: number }) {
  const prisma = {
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
    importJob: {
      count: jest.fn(async ({ where }: { where: { status: string } }) =>
        where.status === 'queued' ? counts.stuck : counts.running,
      ),
    },
  };
  return new ReadinessService(prisma as never);
}

describe('ReadinessService queue check', () => {
  const ping = (svc: ReadinessService) =>
    (svc as unknown as { pingQueue(): Promise<string> }).pingQueue();

  it('is ok with nothing waiting', async () => {
    expect(await ping(service({ stuck: 0, running: 0 }))).toBe('ok');
  });

  it('is down when imports wait and nothing runs', async () => {
    expect(await ping(service({ stuck: 2, running: 0 }))).toBe('down');
  });

  it('is ok when imports wait behind a running one', async () => {
    expect(await ping(service({ stuck: 2, running: 1 }))).toBe('ok');
  });
});

describe('ReadinessService identity check', () => {
  it('defaults to the gratis-gis realm', async () => {
    const saved = { url: process.env.KEYCLOAK_URL, realm: process.env.KEYCLOAK_REALM };
    process.env.KEYCLOAK_URL = 'http://keycloak:8080';
    delete process.env.KEYCLOAK_REALM;
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (url: string) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    }) as never;
    try {
      await service({ stuck: 0, running: 0 }).check();
    } finally {
      globalThis.fetch = realFetch;
      if (saved.url === undefined) delete process.env.KEYCLOAK_URL;
      else process.env.KEYCLOAK_URL = saved.url;
      if (saved.realm !== undefined) process.env.KEYCLOAK_REALM = saved.realm;
    }
    expect(seen.some((u) => u.includes('/realms/gratis-gis/'))).toBe(true);
  });
});
