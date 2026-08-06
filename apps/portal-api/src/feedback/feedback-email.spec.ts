// SPDX-License-Identifier: AGPL-3.0-or-later
import { EmailTransport } from '../notifications/email-transport.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FeedbackService } from './feedback.service.js';

/**
 * The first version of this email said a screenshot was "attached, see
 * the portal" and gave the triage location as "Admin -> Feedback",
 * with no URL. The recipient could tell an image existed and had no
 * way to reach it. These tests pin the fix.
 */
function makeService(sent: Array<Record<string, string>>) {
  const mail = {
    isAvailable: jest.fn().mockResolvedValue(true),
    send: jest.fn(async (msg: Record<string, string>) => {
      sent.push(msg);
    }),
  } as unknown as EmailTransport;
  const prisma = {
    feedback: {
      create: jest.fn().mockResolvedValue({ id: 'fb-abc' }),
      count: jest.fn().mockResolvedValue(0),
    },
  } as unknown as PrismaService;
  const storage = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ key: 'feedback-screenshot/k', publicUrl: '' }),
  } as unknown as StorageService;
  return new FeedbackService(mail, prisma, storage);
}

describe('feedback notification email', () => {
  const saved = { ...process.env };
  const sent: Array<Record<string, string>> = [];

  beforeEach(() => {
    sent.length = 0;
    process.env.FEEDBACK_RECIPIENT_EMAIL = 'ops@example.org';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('links to the triage page at the portal address, not localhost', async () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    await makeService(sent).submit({ message: 'something broke', ip: '1.2.3.4' });
    const msg = sent[0]!;
    expect(msg.text).toContain('https://gratisgis.org/admin/feedback');
    expect(msg.html).toContain('href="https://gratisgis.org/admin/feedback"');
    expect(msg.text).not.toContain('localhost');
  });

  it('does not double the slash when the base URL has a trailing one', async () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org/';
    await makeService(sent).submit({ message: 'something broke', ip: '1.2.3.4' });
    expect(sent[0]!.text).toContain('https://gratisgis.org/admin/feedback');
    expect(sent[0]!.text).not.toContain('org//admin');
  });

  it('says where to view a screenshot when one is attached', async () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    await makeService(sent).submit({
      message: 'look at this',
      ip: '1.2.3.4',
      screenshot: { body: Buffer.from('x'), contentType: 'image/png' },
    });
    const msg = sent[0]!;
    // The old copy claimed an attachment the reader could not open.
    expect(msg.text).not.toContain('see the portal');
    expect(msg.text).toMatch(/screenshot is attached[\s\S]*gratisgis\.org\/admin\/feedback/i);
  });

  it('never puts the reporter IP in the email, since it is not even stored', async () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    await makeService(sent).submit({
      message: 'privacy check',
      ip: '203.0.113.99',
    });
    expect(sent[0]!.text).not.toContain('203.0.113.99');
    expect(sent[0]!.html).not.toContain('203.0.113.99');
  });

  it('stays silent, and does not throw, when no recipient is configured', async () => {
    // The submission is already durable at this point, so a missing
    // inbox must not surface as a failure to the reporter.
    delete process.env.FEEDBACK_RECIPIENT_EMAIL;
    delete process.env.ACME_EMAIL;
    await expect(
      makeService(sent).submit({ message: 'no inbox', ip: '1.2.3.4' }),
    ).resolves.toEqual({ id: 'fb-abc' });
    expect(sent).toHaveLength(0);
  });
});
