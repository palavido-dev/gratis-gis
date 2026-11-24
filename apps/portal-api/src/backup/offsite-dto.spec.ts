// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The off-site request bodies go through the same global pipe as every
 * other route (main.ts): fields a DTO does not declare are refused, so
 * a passphrase or private key never even reaches the service.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import {
  BackupController,
  CheckOffsiteKeyDto,
  StartRestoreTestDto,
  TakeOverOffsiteDto,
  UpdateOffsiteDto,
} from './backup.controller.js';

// The options main.ts installs globally.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const check = (metatype: unknown, body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: metatype as never });

describe('off-site request bodies', () => {
  it.each([
    [UpdateOffsiteDto, { bucket: 'b', passphrase: 'a long enough passphrase' }],
    [UpdateOffsiteDto, { privateKey: 'ggsec1:abc' }],
    [UpdateOffsiteDto, { offsiteInstallId: 'x' }],
    [CheckOffsiteKeyDto, { value: 'ggpub1:x', passphrase: 'p' }],
    [StartRestoreTestDto, { confirmBytes: 1, runId: 'x' }],
    [TakeOverOffsiteDto, { owner: 'aaaaaaaa', installId: 'x' }],
  ])('refuses fields it does not declare (%p)', async (dto, body) => {
    await expect(check(dto, body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the declared fields and their types only', async () => {
    await expect(check(UpdateOffsiteDto, { bucket: 'b', prefix: null })).resolves.toMatchObject({
      bucket: 'b',
    });
    await expect(check(UpdateOffsiteDto, { retentionDays: 'ten' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(check(TakeOverOffsiteDto, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the longest upload: whole hours from 1 to 72, as in the environment', async () => {
    for (const ok of [1, 20, 72, null]) {
      await expect(check(UpdateOffsiteDto, { maxUploadHours: ok })).resolves.toMatchObject({
        maxUploadHours: ok,
      });
    }
    for (const bad of [0, 73, 1.5, '20']) {
      await expect(check(UpdateOffsiteDto, { maxUploadHours: bad })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});

describe('audit of a changed public key', () => {
  it('records both fingerprints, and nothing extra for other saves', async () => {
    const records: Array<Record<string, unknown>> = [];
    let change: { from: string | null; to: string | null } | null = {
      from: 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa',
      to: 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb',
    };
    const offsite = { updateConfig: jest.fn(async () => ({ savedKeyChange: change })) };
    const audit = { record: jest.fn(async (r: Record<string, unknown>) => records.push(r)) };
    const ctl = new BackupController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      offsite as never,
    );
    const user = { id: 'u1', orgId: 'o1' } as never;
    await ctl.updateOffsite(user, {} as UpdateOffsiteDto);
    expect(records[0]).toMatchObject({
      action: 'backup.offsite',
      detail: {
        keyChanged: true,
        oldKeyFingerprint: change.from,
        newKeyFingerprint: change.to,
      },
    });
    change = null;
    await ctl.updateOffsite(user, {} as UpdateOffsiteDto);
    expect(records[1]!.detail).toBeUndefined();
  });
});
