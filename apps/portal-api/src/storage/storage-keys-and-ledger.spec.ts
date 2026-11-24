// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import {
  BoundedLru,
  LEDGER_FILLED_SETTING,
  StorageLedgerService,
} from './storage-ledger.service.js';
import { StorageService, isMissingObjectError } from './storage.service.js';
import { systemOwner } from './object-keys.js';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const U = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab';

describe('StorageService.privateApiUrl', () => {
  it('maps both key layouts to their own route', () => {
    expect(StorageService.privateApiUrl('item-file', `item-file/${U}`)).toBe(
      `/api/portal/storage/private/item-file/${U}`,
    );
    expect(
      StorageService.privateApiUrl('feature-attachment', `feature-attachment/o/${A}/${U}`),
    ).toBe(`/api/portal/storage/private/feature-attachment/o/${A}/${U}`);
  });
});

describe('StorageService.headObjectSizeStrict', () => {
  function serviceWith(send: jest.Mock): StorageService {
    const svc = new StorageService(new ConfigService({}));
    (svc as unknown as { client: { send: jest.Mock } }).client = { send };
    return svc;
  }

  it('answers null only when the object is missing', async () => {
    const missing = Object.assign(new Error('nf'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const svc = serviceWith(jest.fn().mockRejectedValue(missing));
    await expect(svc.headObjectSizeStrict(`item-file/${U}`, systemOwner('t'))).resolves.toBeNull();
  });

  it('throws on any other store error, where headObjectSize would say null', async () => {
    const outage = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    const svc = serviceWith(jest.fn().mockRejectedValue(outage));
    await expect(svc.headObjectSizeStrict(`item-file/${U}`, systemOwner('t'))).rejects.toThrow(
      'socket hang up',
    );
    await expect(svc.headObjectSize(`item-file/${U}`, systemOwner('t'))).resolves.toBeNull();
  });

  it('returns the size of a present object', async () => {
    const svc = serviceWith(jest.fn().mockResolvedValue({ ContentLength: 12 }));
    await expect(svc.headObjectSizeStrict(`item-file/${U}`, systemOwner('t'))).resolves.toBe(12);
  });

  it('recognises the missing-object answers', () => {
    expect(isMissingObjectError({ name: 'NoSuchKey' })).toBe(true);
    expect(isMissingObjectError({ Code: 'NoSuchKey' })).toBe(true);
    expect(isMissingObjectError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isMissingObjectError({ $metadata: { httpStatusCode: 503 } })).toBe(false);
    expect(isMissingObjectError(null)).toBe(false);
  });
});

describe('BoundedLru', () => {
  it('keeps at most its size and drops the least recently used', () => {
    const lru = new BoundedLru<string>(2);
    lru.set('a', '1');
    lru.set('b', '2');
    expect(lru.get('a')).toBe('1');
    lru.set('c', '3');
    expect(lru.size).toBe(2);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('1');
    expect(lru.get('c')).toBe('3');
  });
});

describe('StorageLedgerService owner cache and fill marker', () => {
  function ledgerWith(rows: Array<{ org_id: string }>, marker: unknown = null) {
    const queryRaw = jest.fn(async () => rows);
    const findUnique = jest.fn(async () => marker);
    const upsert = jest.fn(async () => ({}));
    const prisma = {
      $queryRaw: queryRaw,
      systemSetting: { findUnique, upsert },
    } as unknown as PrismaService;
    return { ledger: new StorageLedgerService(prisma), queryRaw, findUnique, upsert };
  }

  it('reads an older key owner once, then from memory', async () => {
    const { ledger, queryRaw } = ledgerWith([{ org_id: A }]);
    for (let i = 0; i < 5; i += 1)
      await expect(ledger.orgOfKey(`item-tile-layer/${U}`)).resolves.toBe(A);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not keep a miss: the key may be recorded later', async () => {
    const { ledger, queryRaw } = ledgerWith([]);
    await ledger.orgOfKey(`item-tile-layer/${U}`);
    await ledger.orgOfKey(`item-tile-layer/${U}`);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('reads the durable marker, not the table, and remembers a fill', async () => {
    const empty = ledgerWith([]);
    await expect(empty.ledger.ledgerFilled()).resolves.toBe(false);
    expect(empty.findUnique).toHaveBeenCalledWith({ where: { key: LEDGER_FILLED_SETTING } });
    // Not re-read on every call while unfilled.
    await empty.ledger.ledgerFilled();
    expect(empty.findUnique).toHaveBeenCalledTimes(1);
    await empty.ledger.markFilled();
    expect(empty.upsert).toHaveBeenCalledTimes(1);
    await expect(empty.ledger.ledgerFilled()).resolves.toBe(true);

    const filled = ledgerWith([], { key: LEDGER_FILLED_SETTING, value: { at: 'x' } });
    await expect(filled.ledger.ledgerFilled()).resolves.toBe(true);
    await filled.ledger.ledgerFilled();
    expect(filled.findUnique).toHaveBeenCalledTimes(1);
  });
});
