// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { TestSmtpDto, describeSmtpTestError } from './admin.controller.js';

describe('SMTP test endpoint input and output', () => {
  it('validates the nested config', async () => {
    const dto = plainToInstance(TestSmtpDto, {
      to: 'a@example.com',
      config: {
        enabled: true,
        host: 'h',
        port: 70000,
        secure: false,
        fromAddress: 'a@example.com',
        fromDisplayName: 'A',
        user: '',
      },
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['config']);
  });

  it('never echoes what the peer sent', () => {
    expect(describeSmtpTestError(new Error('Malformed SMTP reply: SSH-2.0-OpenSSH_9.6'))).not.toMatch(
      /SSH/,
    );
    expect(
      describeSmtpTestError(new Error('SMTP server returned 554: secret banner text')),
    ).toBe('The SMTP server answered 554 and did not accept the message.');
    expect(describeSmtpTestError(new Error('SMTP server returned 535: bad creds'))).toMatch(
      /refused the login/,
    );
    expect(describeSmtpTestError(new Error('SMTP TCP connect timed out after 10ms'))).toBe(
      'Timed out talking to the SMTP server.',
    );
  });
});
