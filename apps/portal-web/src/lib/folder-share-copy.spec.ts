// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import type { ISODateString, ItemShare } from '@gratis-gis/shared-types';
import { postShareCopy, shareCopyBody } from './folder-share-copy';

const NOW = new Date('2026-11-10T12:00:00Z');
function share(over: Partial<ItemShare> = {}): ItemShare {
  return {
    itemId: 'folder-1',
    principalType: 'user',
    principalId: 'u-1',
    permission: 'view',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as ItemShare;
}

describe('shareCopyBody', () => {
  it('forwards the expiry of a time limited share', () => {
    expect(shareCopyBody(share({ expiresAt: '2026-11-14T00:00:00Z' as ISODateString }), NOW)).toEqual({
      principalType: 'user',
      principalId: 'u-1',
      permission: 'view',
      expiresAt: '2026-11-14T00:00:00Z',
    });
  });

  it('skips a share that has already ended', () => {
    expect(shareCopyBody(share({ expiresAt: '2026-11-01T00:00:00Z' as ISODateString }), NOW)).toBeNull();
  });

  it('copies a permanent share without an expiry', () => {
    expect(shareCopyBody(share(), NOW)).not.toHaveProperty('expiresAt');
  });
});

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('postShareCopy', () => {
  const sleep = jest.fn(async () => {});
  beforeEach(() => sleep.mockClear());

  it('retries a 429 and succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '5' }))
      .mockResolvedValueOnce(res(200));
    expect(await postShareCopy('/x', {}, { fetchImpl, sleep })).toBe('ok');
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('reports repeated server errors as errors, not as missing rights', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(502));
    expect(await postShareCopy('/x', {}, { fetchImpl, sleep })).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caps a huge Retry-After', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '99999' }))
      .mockResolvedValueOnce(res(200));
    await postShareCopy('/x', {}, { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('treats a 403 as a permission skip without retrying', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(403));
    expect(await postShareCopy('/x', {}, { fetchImpl, sleep })).toBe('denied');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
