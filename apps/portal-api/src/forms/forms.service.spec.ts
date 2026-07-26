// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { FormsService } from './forms.service.js';

/**
 * Submit-path behaviour pins for FormsService: the server runs the
 * SAME form-schema validate() the browser runtime does (the
 * one-shared-evaluator promise), rejects schema-version mismatches,
 * and keeps the offline re-drain path idempotent. The paired-layer
 * mirror and the owner notification must only ever fire for
 * accepted first-writes.
 */

const SCHEMA = {
  schemaVersion: 1,
  id: 'form-1',
  title: 'Inspection',
  questions: [
    { id: 'name', label: 'Name', type: 'text', required: true },
    {
      id: 'grp',
      label: 'Checks',
      type: 'group',
      repeat: {},
      children: [
        { id: 'result', label: 'Result', type: 'text', required: true },
      ],
    },
  ],
  linkedLayerId: 'layer-1',
  linkedLayerKey: 'submissions',
};

function makeUser(): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'ana',
    email: 'ana@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  } as unknown as AuthUser;
}

function makeMocks(opts: {
  formData?: unknown;
  existingSubmission?: { id: string } | null;
} = {}) {
  const prisma = {
    item: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === 'form-1') {
          return {
            id: 'form-1',
            type: 'form',
            orgId: 'org-1',
            ownerId: 'owner-1',
            access: 'org',
            title: 'Inspection',
            data: opts.formData ?? SCHEMA,
          };
        }
        // Paired-layer lookup inside the mirror path; null keeps the
        // mirror on the table-insert branch with no sublayers.
        return null;
      }),
    },
    itemShare: { findFirst: jest.fn(async () => null) },
    formSubmission: {
      findUnique: jest.fn(async () => opts.existingSubmission ?? null),
      upsert: jest.fn(async () => ({ id: 'sub-1', createdAt: new Date() })),
    },
    user: {
      findUnique: jest.fn(async () => ({
        fullName: 'Ana',
        username: 'ana',
        email: 'ana@example.com',
      })),
    },
  };
  const notifications = {
    notify: jest.fn(async () => undefined),
    notifyAddress: jest.fn(async () => undefined),
  };
  const dataLayerFeatures = { insertFeatures: jest.fn(async () => undefined) };
  const dataLayerAttachments = { register: jest.fn(async () => undefined) };
  const service = new FormsService(
    prisma as unknown as ConstructorParameters<typeof FormsService>[0],
    notifications as unknown as ConstructorParameters<typeof FormsService>[1],
    dataLayerFeatures as unknown as ConstructorParameters<typeof FormsService>[2],
    dataLayerAttachments as unknown as ConstructorParameters<typeof FormsService>[3],
  );
  return { service, prisma, notifications, dataLayerFeatures };
}

/** Let the fire-and-forget notify / mirror promises settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const VALID_DTO = {
  clientId: 'client-000001',
  schemaVersion: 1,
  response: { name: 'Ana', grp: [{ result: 'ok' }] },
  capturedAt: '2026-07-25T12:00:00.000Z',
};

describe('FormsService.submit', () => {
  it('accepts a valid submission and mirrors it to the paired layer', async () => {
    const m = makeMocks();
    const result = await m.service.submit('form-1', makeUser(), VALID_DTO);
    expect(result).toEqual({ id: 'sub-1', created: true });
    expect(m.prisma.formSubmission.upsert).toHaveBeenCalledTimes(1);
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).toHaveBeenCalled();
    expect(m.notifications.notify).toHaveBeenCalled();
  });

  it('rejects an invalid submission with a 400 listing field errors', async () => {
    const m = makeMocks();
    const dto = {
      ...VALID_DTO,
      // Missing required top-level `name`; empty required child in
      // the repeat instance.
      response: { grp: [{}] },
    };
    let caught: unknown = null;
    try {
      await m.service.submit('form-1', makeUser(), dto);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as {
      message: string;
      fieldErrors: Array<{ questionId: string; message: string }>;
    };
    expect(body.message).toContain('name');
    expect(body.message).toContain('grp[0].result');
    expect(body.fieldErrors).toEqual([
      { questionId: 'name', message: 'This field is required.' },
      { questionId: 'grp[0].result', message: 'This field is required.' },
    ]);
    // Nothing stored, nothing mirrored, nobody notified.
    expect(m.prisma.formSubmission.upsert).not.toHaveBeenCalled();
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
    expect(m.notifications.notify).not.toHaveBeenCalled();
  });

  it('rejects a schema-version mismatch with a clear message', async () => {
    const m = makeMocks();
    const dto = { ...VALID_DTO, schemaVersion: 2 };
    await expect(m.service.submit('form-1', makeUser(), dto)).rejects.toThrow(
      /captured against schema version 2[\s\S]*current schema version is 1/,
    );
    expect(m.prisma.formSubmission.upsert).not.toHaveBeenCalled();
  });

  it('rejects submissions to a form without a usable schema', async () => {
    const m = makeMocks({ formData: { note: 'not a schema' } });
    await expect(
      m.service.submit('form-1', makeUser(), VALID_DTO),
    ).rejects.toThrow(/no saved schema/);
  });

  it('short-circuits a re-drained clientId without re-validating', async () => {
    // The row is already durably stored; re-validating against a
    // possibly-evolved schema would wedge the offline outbox in a
    // permanent retry loop. Send a response that would FAIL
    // validation to prove validation is skipped on this path.
    const m = makeMocks({ existingSubmission: { id: 'sub-existing' } });
    const dto = { ...VALID_DTO, response: {} };
    const result = await m.service.submit('form-1', makeUser(), dto);
    expect(result).toEqual({ id: 'sub-existing', created: false });
    expect(m.prisma.formSubmission.upsert).not.toHaveBeenCalled();
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
    expect(m.notifications.notify).not.toHaveBeenCalled();
  });
});
