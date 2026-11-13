// SPDX-License-Identifier: AGPL-3.0-or-later
import { INLINE_PDF_CSP, StorageController } from './storage.controller.js';

/**
 * The file item's PDF preview frame asks for `?inline=1`. The route
 * used to send every non-image as an attachment, so the frame stayed
 * blank and the browser downloaded the file. A PDF now opens inline
 * under a sandbox policy; everything else is unchanged.
 */
const KEY = '0f8fe0ab-1111-4222-8333-444455556666';

function harness(contentType: string) {
  const prisma = {
    $queryRaw: jest.fn(async () => [{ id: 'item-1' }]),
    item: {
      findUnique: jest.fn(async () => ({
        id: 'item-1',
        type: 'file',
        data: { fileName: 'plan.pdf' },
        access: 'public',
      })),
    },
  };
  const storage = {
    streamObject: jest.fn(async () => ({
      statusCode: 200,
      contentType,
      body: { pipe: jest.fn(), destroy: jest.fn() },
    })),
  };
  const controller = new StorageController(
    storage as never,
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const headers = new Map<string, string>();
  const res = {
    on: jest.fn(),
    status: jest.fn(),
    setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
  };
  const get = (inline: string | undefined) =>
    controller.getPrivateAsset(null, 'item-file', KEY, undefined, inline, {} as never, res as never);
  return { get, headers };
}

describe('private file route, inline PDF', () => {
  it('serves a PDF inline under a sandbox policy when asked', async () => {
    const h = harness('application/pdf');
    await h.get('1');
    expect(h.headers.get('content-disposition')).toMatch(/^inline/);
    expect(h.headers.get('content-security-policy')).toBe(INLINE_PDF_CSP);
    expect(INLINE_PDF_CSP).toMatch(/^sandbox/);
  });

  it('still downloads a PDF without the flag', async () => {
    const h = harness('application/pdf');
    await h.get(undefined);
    expect(h.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(h.headers.has('content-security-policy')).toBe(false);
  });

  it('does not open other types inline because of the flag', async () => {
    const h = harness('text/html');
    await h.get('1');
    expect(h.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(h.headers.has('content-security-policy')).toBe(false);
  });
});
