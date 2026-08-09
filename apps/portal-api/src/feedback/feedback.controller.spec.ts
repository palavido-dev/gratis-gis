// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

import { FeedbackController } from './feedback.controller.js';
import type { FeedbackService } from './feedback.service.js';

function req(overrides: Partial<Request> = {}): Request {
  return {
    headers: { 'user-agent': 'jest' },
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
    ...overrides,
  } as unknown as Request;
}

function makeController(svc: Partial<FeedbackService> = {}) {
  const service = {
    isRateLimited: jest.fn().mockResolvedValue(false),
    submit: jest.fn().mockResolvedValue({ id: 'fb-1' }),
    ...svc,
  } as unknown as FeedbackService;
  return { controller: new FeedbackController(service), service };
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);

describe('FeedbackController', () => {
  const saved = process.env.PORTAL_FEEDBACK_ENABLED;
  beforeEach(() => {
    process.env.PORTAL_FEEDBACK_ENABLED = '1';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PORTAL_FEEDBACK_ENABLED;
    else process.env.PORTAL_FEEDBACK_ENABLED = saved;
  });

  describe('the opt-in flag', () => {
    it('has no endpoint at all when feedback is off', async () => {
      delete process.env.PORTAL_FEEDBACK_ENABLED;
      const { controller, service } = makeController();
      await expect(
        controller.submit({ message: 'hello there' }, req()),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Nothing reaches storage or the database on a disabled portal.
      expect(service.submit).not.toHaveBeenCalled();
    });

    it.each(['0', 'false', 'no', '', 'off', 'maybe'])(
      'stays off for PORTAL_FEEDBACK_ENABLED=%s',
      async (value) => {
        process.env.PORTAL_FEEDBACK_ENABLED = value;
        const { controller } = makeController();
        await expect(
          controller.submit({ message: 'hello there' }, req()),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it.each(['1', 'true', 'yes', 'on', 'TRUE', ' 1 '])(
      'turns on for PORTAL_FEEDBACK_ENABLED=%s',
      async (value) => {
        process.env.PORTAL_FEEDBACK_ENABLED = value;
        const { controller } = makeController();
        await expect(
          controller.submit({ message: 'hello there' }, req()),
        ).resolves.toEqual({ ok: true });
      },
    );
  });

  describe('the honeypot', () => {
    it('answers 200 but stores nothing, so the bot learns nothing', async () => {
      const { controller, service } = makeController();
      await expect(
        controller.submit(
          { message: 'buy my product', company: 'SpamCo' },
          req(),
        ),
      ).resolves.toEqual({ ok: true });
      expect(service.submit).not.toHaveBeenCalled();
    });

    it('does not spend the rate-limit budget of the address it came from', async () => {
      // A stored bot submission would count against a real reporter
      // who happens to share a NAT gateway with it.
      const { controller, service } = makeController();
      await controller.submit({ message: 'spam', company: 'x' }, req());
      expect(service.isRateLimited).not.toHaveBeenCalled();
    });

    it('ignores a whitespace-only honeypot, which a browser can autofill', async () => {
      const { controller, service } = makeController();
      await controller.submit({ message: 'a real report', company: '   ' }, req());
      expect(service.submit).toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('refuses with 429 when the source is over budget', async () => {
      const { controller, service } = makeController({
        isRateLimited: jest.fn().mockResolvedValue(true),
      } as Partial<FeedbackService>);
      await expect(
        controller.submit({ message: 'hello there' }, req()),
      ).rejects.toMatchObject({ status: 429 });
      expect(service.submit).not.toHaveBeenCalled();
    });

    it('reads the real client from the RIGHT of X-Forwarded-For, not the spoofable left', async () => {
      // The socket address is always Caddy's, so limiting on it would
      // rate-limit the whole internet as one client. But the leftmost
      // XFF entry is client-controlled: Caddy appends the true peer, so
      // a client sending `X-Forwarded-For: 198.51.100.9` just prepends a
      // fake. The real client (Caddy's appended last hop) is 10.0.0.1
      // here, and that is what must key the limiter.
      const { controller, service } = makeController();
      await controller.submit(
        { message: 'hello there' },
        req({
          headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
        } as Partial<Request>),
      );
      expect(service.isRateLimited).toHaveBeenCalledWith('10.0.0.1');
      expect(service.submit).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '10.0.0.1' }),
      );
    });
  });

  describe('screenshots', () => {
    it('trusts the bytes, not the declared content type', async () => {
      const { controller, service } = makeController();
      await controller.submit({ message: 'look at this' }, req(), {
        buffer: PNG,
        // A lie: the client says JPEG, the bytes say PNG.
        mimetype: 'image/jpeg',
      });
      expect(service.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshot: expect.objectContaining({ contentType: 'image/png' }),
        }),
      );
    });

    it('refuses a non-image loudly rather than silently dropping it', async () => {
      // A reporter who attached something deserves to know it did not
      // arrive; silently discarding it looks like it worked.
      const { controller } = makeController();
      await expect(
        controller.submit({ message: 'here you go' }, req(), {
          buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
          mimetype: 'image/svg+xml',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a submission with no attachment', async () => {
      const { controller, service } = makeController();
      await controller.submit({ message: 'no picture' }, req());
      expect(service.submit).toHaveBeenCalledWith(
        expect.not.objectContaining({ screenshot: expect.anything() }),
      );
    });

    it('ignores a zero-byte file part', async () => {
      const { controller, service } = makeController();
      await controller.submit({ message: 'empty part' }, req(), {
        buffer: Buffer.alloc(0),
        mimetype: 'image/png',
      });
      expect(service.submit).toHaveBeenCalledWith(
        expect.not.objectContaining({ screenshot: expect.anything() }),
      );
    });
  });

  describe('captured context', () => {
    it('records the signed-in user when a session happens to be present', async () => {
      const { controller, service } = makeController();
      await controller.submit(
        { message: 'signed in report', pageUrl: '/items/abc', viewport: '1512x945' },
        req({ user: { id: 'u-1', orgId: 'o-1' } } as unknown as Partial<Request>),
      );
      expect(service.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-1',
          orgId: 'o-1',
          pageUrl: '/items/abc',
          viewport: '1512x945',
        }),
      );
    });

    it('works anonymously, which is the entire point', async () => {
      const { controller, service } = makeController();
      await controller.submit({ message: 'anon report' }, req());
      expect(service.submit).toHaveBeenCalledWith(
        expect.not.objectContaining({ userId: expect.anything() }),
      );
    });

    it('rejects a message that is only whitespace', async () => {
      const { controller } = makeController();
      await expect(
        controller.submit({ message: '   \n  ' }, req()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('truncates an absurd user-agent rather than storing it whole', async () => {
      const { controller, service } = makeController();
      await controller.submit(
        { message: 'long ua' },
        req({ headers: { 'user-agent': 'A'.repeat(5000) } } as Partial<Request>),
      );
      const arg = (service.submit as jest.Mock).mock.calls[0][0];
      expect(arg.userAgent.length).toBeLessThanOrEqual(512);
    });
  });
});

// A 429 must be an HttpException so Nest renders the status, not a
// generic 500. Guards against a refactor that throws a plain Error.
describe('rate-limit rejection shape', () => {
  it('is an HttpException', async () => {
    process.env.PORTAL_FEEDBACK_ENABLED = '1';
    const { controller } = makeController({
      isRateLimited: jest.fn().mockResolvedValue(true),
    } as Partial<FeedbackService>);
    await expect(
      controller.submit({ message: 'hello there' }, req()),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

// ---------------------------------------------------------------------
// clientIp: the value that keys the rate limiter and the stored ipHash
// ---------------------------------------------------------------------

import { clientIp } from './feedback.controller.js';

describe('clientIp (rate-limit key must not be spoofable)', () => {
  it('reads the rightmost X-Forwarded-For entry, not the client-supplied left', () => {
    // Caddy appends the true peer as the last hop, so the rightmost
    // entry is the real client. A client that stuffs the left with a
    // fake IP to dodge the rate limit gets ignored.
    const ip = clientIp(
      req({ headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' } } as never),
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('handles a single-entry header', () => {
    expect(
      clientIp(req({ headers: { 'x-forwarded-for': '203.0.113.7' } } as never)),
    ).toBe('203.0.113.7');
  });

  it('falls back to req.ip when there is no forwarded header', () => {
    expect(clientIp(req({ headers: {} } as never))).toBe('203.0.113.7');
  });
});
