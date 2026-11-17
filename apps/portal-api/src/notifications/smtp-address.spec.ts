// SPDX-License-Identifier: AGPL-3.0-or-later
import { hasLineBreak, isPlainEmailAddress } from './email-address.js';
import { sendSmtpMail } from './smtp-client.js';

describe('recipient address checks', () => {
  it('accepts a plain address', () => {
    expect(isPlainEmailAddress('ana.b+forms@example.org')).toBe(true);
  });

  it.each([
    'a@b.c\r\nRSET',
    'a@b.c\nBcc: x@y.z',
    'Ana <ana@example.org>',
    'ana@example.org>',
    'no-at-sign',
    'a b@example.org',
    'ana@',
  ])('refuses %j', (value) => {
    expect(isPlainEmailAddress(value)).toBe(false);
  });

  it('spots CR, LF and NUL', () => {
    expect(hasLineBreak('a\rb')).toBe(true);
    expect(hasLineBreak('a\nb')).toBe(true);
    expect(hasLineBreak('a\0b')).toBe(true);
    expect(hasLineBreak('ana@example.org')).toBe(false);
  });

  it('sendSmtpMail refuses a recipient with a line break before connecting', async () => {
    await expect(
      sendSmtpMail(
        { host: '127.0.0.1', port: 1, secure: false },
        {
          from: 'Portal <noreply@example.org>',
          to: 'a@b.c\r\nRSET',
          subject: 's',
          text: 't',
          html: '<p>t</p>',
        },
      ),
    ).rejects.toThrow(/line break/);
  });
});
