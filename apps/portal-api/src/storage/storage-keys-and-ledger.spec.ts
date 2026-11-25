// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import {
  BoundedLru,
  FILLED_REREAD_MS,
  LEDGER_FILLED_SETTING,
  StorageLedgerService,
  forgetLedgerState,
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

  it('keeps the last value read when a read fails, and refuses when none was read', async () => {
    const t0 = 1_000_000;
    const never = ledgerWith([]);
    never.findUnique.mockRejectedValue(new Error('db down'));
    // No value read yet: older keys with no row are refused.
    await expect(never.ledger.ledgerFilled(t0)).resolves.toBe(true);

    const filled = ledgerWith([], { key: LEDGER_FILLED_SETTING, value: { at: 'x' } });
    await expect(filled.ledger.ledgerFilled(t0)).resolves.toBe(true);
    filled.findUnique.mockRejectedValue(new Error('db down'));
    await expect(filled.ledger.ledgerFilled(t0 + FILLED_REREAD_MS)).resolves.toBe(true);

    const notYet = ledgerWith([]);
    await expect(notYet.ledger.ledgerFilled(t0)).resolves.toBe(false);
    notYet.findUnique.mockRejectedValue(new Error('db down'));
    await expect(notYet.ledger.ledgerFilled(t0 + 60_000)).resolves.toBe(false);
    expect(notYet.findUnique).toHaveBeenCalledTimes(2);
  });

  it('re-reads a filled marker every few minutes and sees it removed', async () => {
    const t0 = 1_000_000;
    const { ledger, findUnique } = ledgerWith([], { key: LEDGER_FILLED_SETTING, value: {} });
    await expect(ledger.ledgerFilled(t0)).resolves.toBe(true);
    await expect(ledger.ledgerFilled(t0 + FILLED_REREAD_MS - 1)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    findUnique.mockResolvedValue(null);
    await expect(ledger.ledgerFilled(t0 + FILLED_REREAD_MS)).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('forgets the marker and cached owners after a restore', async () => {
    const t0 = 1_000_000;
    const { ledger, findUnique, queryRaw } = ledgerWith([{ org_id: A }], {
      key: LEDGER_FILLED_SETTING,
      value: {},
    });
    await expect(ledger.ledgerFilled(t0)).resolves.toBe(true);
    await ledger.orgOfKey(`item-tile-layer/${U}`);
    findUnique.mockResolvedValue(null);
    queryRaw.mockResolvedValue([]);
    forgetLedgerState();
    // Read again at once, not after the re-read interval.
    await expect(ledger.ledgerFilled(t0 + 1)).resolves.toBe(false);
    await expect(ledger.orgOfKey(`item-tile-layer/${U}`)).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
