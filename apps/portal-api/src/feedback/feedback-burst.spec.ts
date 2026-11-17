// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EmailTransport } from '../notifications/email-transport.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { SHORT_LIMIT } from './feedback-config.js';
import { FeedbackService } from './feedback.service.js';

/**
 * A parallel burst from one source must not slip past the limit. The
 * fake below behaves like Postgres for the parts that matter: the
 * advisory lock is held until the transaction ends, and a row is
 * visible to later counts once inserted.
 */
function makeDb() {
  const rows: Array<{ ipHash: string; createdAt: Date }> = [];
  const locks = new Map<string, Promise<void>>();
  const feedback = {
    count: jest.fn(async ({ where }: { where: { ipHash: string } }) => {
      await new Promise((r) => setImmediate(r));
      return rows.filter((r) => r.ipHash === where.ipHash).length;
    }),
    create: jest.fn(async ({ data }: { data: { ipHash: string } }) => {
      await new Promise((r) => setImmediate(r));
      rows.push({ ipHash: data.ipHash, createdAt: new Date() });
      return { id: `fb-${rows.length}` };
    }),
    update: jest.fn(async () => ({})),
  };
  const prisma = {
    feedback,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let release: () => void = () => undefined;
      const tx = {
        feedback,
        $executeRaw: async (_s: TemplateStringsArray, key: string) => {
          while (locks.has(key)) await locks.get(key);
          locks.set(key, new Promise<void>((r) => (release = () => {
            locks.delete(key);
            r();
          })));
        },
      };
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  };
  return { prisma, rows };
}

describe('feedback rate limit under a burst', () => {
  it('stores at most the short-window limit from one source', async () => {
    const { prisma, rows } = makeDb();
    const svc = new FeedbackService(
      { isAvailable: async () => false } as unknown as EmailTransport,
      prisma as unknown as PrismaService,
      {} as StorageService,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        svc.submit({ message: 'burst', ip: '203.0.113.9' }),
      ),
    );
    expect(rows).toHaveLength(SHORT_LIMIT);
    const refused = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { getStatus?: () => number }).getStatus?.() === 429,
    );
    expect(refused).toHaveLength(10 - SHORT_LIMIT);
  });
});
