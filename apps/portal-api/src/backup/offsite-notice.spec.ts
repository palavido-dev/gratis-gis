// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderNotification } from '../notifications/templates.js';
import { BackupFailureNotice } from './backup-failure-notice.js';

describe('off-site notices', () => {
  const saved = process.env.GRATIS_OPERATOR_ORG_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.GRATIS_OPERATOR_ORG_ID;
    else process.env.GRATIS_OPERATOR_ORG_ID = saved;
  });

  function make() {
    const keys = new Set<string>();
    const prisma = {
      backupOffsiteNotice: {
        create: jest.fn(async ({ data }: { data: { key: string } }) => {
          if (keys.has(data.key)) throw Object.assign(new Error('dup'), { code: 'P2002' });
          keys.add(data.key);
          return data;
        }),
      },
      organization: { findFirst: jest.fn(async () => ({ id: 'org-1' })) },
      user: { findMany: jest.fn(async () => [{ id: 'admin-1' }, { id: 'admin-2' }]) },
    };
    const notifications = { notifyMany: jest.fn(async () => undefined) };
    return {
      notice: new BackupFailureNotice(prisma as never, notifications as never),
      notifications,
    };
  }

  it('sends once per key to the operator admins, with no error text', async () => {
    delete process.env.GRATIS_OPERATOR_ORG_ID;
    const { notice, notifications } = make();
    expect(await notice.announceOffsite('failed:r1', { runId: 'r1', kind: 'offsite_failed' })).toBe(
      true,
    );
    expect(await notice.announceOffsite('failed:r1', { runId: 'r1', kind: 'offsite_failed' })).toBe(
      false,
    );
    expect(notifications.notifyMany).toHaveBeenCalledTimes(1);
    expect(notifications.notifyMany).toHaveBeenCalledWith(['admin-1', 'admin-2'], 'backup_failed', {
      kind: 'offsite_failed',
      runId: 'r1',
    });
  });

  it('a new quiet period is a new notice', async () => {
    const { notice, notifications } = make();
    await notice.announceOffsite('stale:r1', { kind: 'offsite_stale', days: 4 });
    await notice.announceOffsite('stale:r1', { kind: 'offsite_stale', days: 5 });
    await notice.announceOffsite('stale:r2', { kind: 'offsite_stale', days: 4 });
    expect(notifications.notifyMany).toHaveBeenCalledTimes(2);
  });

  it('renders each kind in plain words', () => {
    const ctx = { orgLabel: 'Acme', baseUrl: 'https://p.example' };
    expect(
      renderNotification('backup_failed', { runId: 'r1', kind: 'offsite_failed' }, ctx)!.subject,
    ).toBe('An off-site backup copy failed on Acme');
    expect(
      renderNotification('backup_failed', { kind: 'offsite_stale', days: 4 }, ctx)!.text,
    ).toContain('The last good off-site backup copy is 4 days old.');
    expect(
      renderNotification('backup_failed', { kind: 'offsite_stale', days: null }, ctx)!.text,
    ).toContain('No off-site backup copy has succeeded yet.');
    expect(renderNotification('backup_failed', { runId: 'r1' }, ctx)!.subject).toBe(
      'A backup did not finish on Acme',
    );
  });

  it('renders the set-aside summary, a stopped clean-up, and who changed the signing key', () => {
    const ctx = { orgLabel: 'Acme', baseUrl: 'https://p.example' };
    const aside = renderNotification(
      'backup_failed',
      { kind: 'offsite_set_aside', count: 5, badSignature: 3, dated: 2, name: 'a, b and 3 more' },
      ctx,
    )!;
    expect(aside.subject).toBe('Off-site backup copies were set aside on Acme');
    expect(aside.text).toContain('5 off-site copies in the bucket were set aside: 3 not signed');
    expect(aside.text).toContain('Copies: a, b and 3 more');
    const stopped = renderNotification(
      'backup_failed',
      { kind: 'offsite_retention_stopped', name: 'backup-x.tar.gz.enc' },
      ctx,
    )!;
    expect(stopped.subject).toBe('Off-site backup clean-up stopped on Acme');
    expect(stopped.text).toContain('deleted nothing');
    const auto = renderNotification(
      'backup_failed',
      { kind: 'offsite_signing_key_changed', from: 'a', to: 'b', automatic: true },
      ctx,
    )!;
    expect(auto.text).toContain('The server replaced it by itself');
    expect(auto.text).toContain('still count as good');
    const autoDropped = renderNotification(
      'backup_failed',
      { kind: 'offsite_signing_key_changed', from: 'a', to: 'b', automatic: true, oldKeyKept: false },
      ctx,
    )!;
    expect(autoDropped.text).toContain('set aside (kept, not deleted)');
    const byAdmin = renderNotification(
      'backup_failed',
      { kind: 'offsite_signing_key_changed', from: 'a', to: 'b', automatic: false },
      ctx,
    )!;
    expect(byAdmin.text).toContain('An admin replaced it');
  });

  it('carries only the fields given, and never an empty run id', async () => {
    const { notice, notifications } = make();
    await notice.announceOffsite('set-aside:x', {
      kind: 'offsite_set_aside',
      count: 2,
      badSignature: 1,
      dated: 1,
      name: 'a, b',
    });
    expect(notifications.notifyMany).toHaveBeenCalledWith(expect.anything(), 'backup_failed', {
      kind: 'offsite_set_aside',
      count: 2,
      badSignature: 1,
      dated: 1,
      name: 'a, b',
    });
  });
});
