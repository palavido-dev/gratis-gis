// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsAdminController } from './admin.controller.js';
import type { EmailTransport } from './email-transport.js';
import {
  SystemSettingsService,
  sameSmtpTarget,
  type SmtpConfig,
} from './system-settings.service.js';

/**
 * The stored SMTP password used to be reused whenever a request left
 * the password out, even when the host changed, so an admin could
 * make the server send it to a host they run (15-1, 16-2). It is now
 * reused only for the same host, port and user.
 */
const stored: SmtpConfig = {
  enabled: true,
  host: 'smtp.example.org',
  port: 587,
  secure: false,
  fromAddress: 'portal@example.org',
  fromDisplayName: 'Portal',
  user: 'relay',
  password: 'REAL-SECRET',
  hasPassword: true,
};

const ME = { id: 'admin-1', email: 'a@b.co' } as never;

describe('sameSmtpTarget', () => {
  it('matches only the same host, port and user', () => {
    expect(sameSmtpTarget(stored, { host: 'SMTP.example.org ', port: 587, user: 'relay' })).toBe(true);
    expect(sameSmtpTarget(stored, { host: 'evil.example', port: 587, user: 'relay' })).toBe(false);
    expect(sameSmtpTarget(stored, { host: 'smtp.example.org', port: 25, user: 'relay' })).toBe(false);
    expect(sameSmtpTarget(stored, { host: 'smtp.example.org', port: 587, user: 'x' })).toBe(false);
    expect(sameSmtpTarget(null, stored)).toBe(false);
  });
});

describe('SMTP test send', () => {
  function controller() {
    const sendTest = jest.fn(async () => undefined);
    const settings = { getSmtpConfig: jest.fn(async () => stored) };
    const ctl = new NotificationsAdminController(
      {} as never,
      settings as unknown as SystemSettingsService,
      {} as never,
      {} as never,
      { sendTest } as unknown as EmailTransport,
      {} as never,
    );
    return { ctl, sendTest };
  }
  const config = (host: string) => ({
    enabled: true,
    host,
    port: 587,
    secure: false,
    fromAddress: 'a@b.co',
    fromDisplayName: '',
    user: 'relay',
  });

  it('refuses to send the stored password to another host', async () => {
    const { ctl, sendTest } = controller();
    await expect(
      ctl.testSmtp(ME, { config: config('evil.example') } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sendTest).not.toHaveBeenCalled();
  });

  it('still fills it in for the stored host', async () => {
    const { ctl, sendTest } = controller();
    await ctl.testSmtp(ME, { config: config('smtp.example.org') } as never);
    expect(sendTest).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.org', password: 'REAL-SECRET' }),
      'a@b.co',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('sends only to the signed-in admin', async () => {
    const { ctl, sendTest } = controller();
    const out = await ctl.testSmtp(ME, { config: config('smtp.example.org') } as never);
    expect(out).toMatchObject({ ok: true, sentTo: 'a@b.co' });
    expect((sendTest.mock.calls[0] as unknown[] | undefined)?.[1]).toBe('a@b.co');
  });

  it('refuses when the account has only a placeholder address', async () => {
    const { ctl, sendTest } = controller();
    const out = await ctl.testSmtp(
      { id: 'admin-1', email: 'demo@local.gratisgis' } as never,
      { config: config('smtp.example.org') } as never,
    );
    expect(out.ok).toBe(false);
    expect(sendTest).not.toHaveBeenCalled();
  });
});

describe('SMTP save', () => {
  function settings() {
    const row = {
      value: { enabled: true, host: 'smtp.example.org', port: 587, secure: false, user: 'relay' },
      encryptedSecret: 'cipher',
      encryptedSecretIv: 'iv',
    };
    const upsert = jest.fn(async () => ({}));
    const svc = new SystemSettingsService(
      { systemSetting: { findUnique: jest.fn(async () => row), upsert } } as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
    );
    return { svc, upsert };
  }
  const input = (host: string) => ({
    enabled: true,
    host,
    port: 587,
    secure: false,
    fromAddress: 'a@b.co',
    fromDisplayName: '',
    user: 'relay',
  });

  it('refuses a new host without the password, before writing', async () => {
    const { svc, upsert } = settings();
    await expect(svc.saveSmtpConfig(input('evil.example'), 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps the stored password when only other fields change', async () => {
    const { svc, upsert } = settings();
    await svc.saveSmtpConfig({ ...input('smtp.example.org'), fromDisplayName: 'New' }, 'u1');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ encryptedSecret: 'cipher' }),
      }),
    );
  });
});
