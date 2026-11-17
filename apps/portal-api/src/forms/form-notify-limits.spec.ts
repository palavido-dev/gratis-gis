// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import { isPlainEmailAddress } from '../notifications/email-address.js';
import type { NotificationTypeDefaultService } from '../notifications/notification-type-default.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  MAX_FORM_EXTRA_RECIPIENTS,
  assertFormNotifyLimits,
  formExtraRecipients,
} from './form-notify-limits.js';

/**
 * Form extra recipients let any form author mail outside addresses
 * through the install's SMTP identity (10-3, 16-5). The list is now
 * capped at save and at send, and each sender has an hourly budget.
 */
const addrs = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@example.org`);

describe('form extra recipients', () => {
  it('refuses a save with too many', () => {
    expect(() =>
      assertFormNotifyLimits({ notify: { extraRecipients: addrs(MAX_FORM_EXTRA_RECIPIENTS + 1) } }),
    ).toThrow(BadRequestException);
    expect(() =>
      assertFormNotifyLimits({ notify: { extraRecipients: addrs(MAX_FORM_EXTRA_RECIPIENTS) } }),
    ).not.toThrow();
    expect(() => assertFormNotifyLimits({ questions: [] })).not.toThrow();
  });

  it('sends to at most the cap, without duplicates or invalid addresses', () => {
    const raw = ['A@example.org', 'a@example.org', 'not an address', 7, ...addrs(20)];
    const out = formExtraRecipients(raw, isPlainEmailAddress);
    expect(out).toHaveLength(MAX_FORM_EXTRA_RECIPIENTS);
    expect(out[0]).toBe('A@example.org');
    expect(out).not.toContain('a@example.org');
  });
});

describe('notifyAddress hourly budget', () => {
  const prev = process.env.NOTIFY_ADDRESS_HOURLY_LIMIT;
  afterEach(() => {
    if (prev === undefined) delete process.env.NOTIFY_ADDRESS_HOURLY_LIMIT;
    else process.env.NOTIFY_ADDRESS_HOURLY_LIMIT = prev;
  });

  function build(alreadySent: number) {
    const create = jest.fn(async () => ({}));
    const count = jest.fn(async () => alreadySent);
    const prisma = {
      notification: { create, count },
      user: { findUnique: jest.fn(async () => ({ email: 'owner@example.org' })) },
    };
    const svc = new NotificationsService(
      prisma as unknown as PrismaService,
      {} as NotificationTypeDefaultService,
      { get: () => 'true' } as unknown as ConfigService,
    );
    return { svc, create, count };
  }

  it('queues while under the budget and leaves the sender own mail out of the count', async () => {
    process.env.NOTIFY_ADDRESS_HOURLY_LIMIT = '3';
    const { svc, create, count } = build(2);
    await svc.notifyAddress('owner', 'form_submission_received', {}, 'x@example.org');
    expect(create).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'owner',
        NOT: { address: 'owner@example.org' },
      }),
    });
  });

  it('stops queueing once the budget is used', async () => {
    process.env.NOTIFY_ADDRESS_HOURLY_LIMIT = '3';
    const { svc, create } = build(3);
    await svc.notifyAddress('owner', 'form_submission_received', {}, 'x@example.org');
    expect(create).not.toHaveBeenCalled();
  });
});
