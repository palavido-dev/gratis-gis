// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { _resetKeyCacheForTests } from '../items/credential-cipher.js';
import { emptyConfigRow, makePrisma, type Row } from '../testing/offsite-fixtures.js';
import { BackupController } from './backup.controller.js';
import type { BackupService } from './backup.service.js';
import { OffsiteService } from './offsite.service.js';

/**
 * The signing key routes: the private half is never in an answer, an
 * audit row, a notice or a log line; fingerprints are.
 */
describe('off-site signing key routes', () => {
  const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
  let cfg: Row;
  let svc: OffsiteService;
  let ctrl: BackupController;
  let audit: { record: jest.Mock };
  let notice: { announceOffsite: jest.Mock };
  let logged: string[];
  const user = { id: 'admin-user', orgId: 'operator-org' } as never;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    cfg = { ...emptyConfigRow(), offsiteInstallId: '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f0' };
    notice = { announceOffsite: jest.fn(async () => true) };
    svc = new OffsiteService(
      makePrisma([], cfg) as never,
      { configRow: async () => cfg, onRunSucceeded: jest.fn() } as unknown as BackupService,
      notice as never,
    );
    audit = { record: jest.fn(async () => undefined) };
    ctrl = new BackupController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      svc,
    );
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
    _resetKeyCacheForTests();
  });

  it('a new signing key is audited with fingerprints only, and its private half goes nowhere', async () => {
    const before = await svc.signingKey();
    const answer = await ctrl.replaceOffsiteSigningKey(user);
    const after = await svc.signingKey();
    expect(after.verifyKey.text).not.toBe(before.verifyKey.text);
    expect(answer.signing.verifyKey).toBe(after.verifyKey.text);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.offsite',
        actorUserId: 'admin-user',
        detail: {
          signingKeyChanged: true,
          oldVerifyKeyFingerprint: before.verifyKey.fingerprintText,
          newVerifyKeyFingerprint: after.verifyKey.fingerprintText,
        },
      }),
    );
    const everywhere = JSON.stringify([
      answer,
      await ctrl.getOffsite(),
      await ctrl.checkOffsiteVerifyKey({ value: after.verifyKey.text }),
      audit.record.mock.calls,
      notice.announceOffsite.mock.calls,
      logged,
    ]);
    for (const k of [before, after]) {
      for (const form of ['base64', 'base64url', 'hex'] as const) {
        expect(everywhere).not.toContain(k.seed.toString(form));
      }
    }
    expect(everywhere).not.toContain(String(cfg.offsiteSigningKeyEncrypted));
  });

  it('check my verify key answers for the current key and an earlier one', async () => {
    const first = await svc.signingKey();
    await ctrl.replaceOffsiteSigningKey(user);
    expect(
      await ctrl.checkOffsiteVerifyKey({ value: first.verifyKey.fingerprintText }),
    ).toMatchObject({ matches: false, previous: true });
  });
});
