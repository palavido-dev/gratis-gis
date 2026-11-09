// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { FormsService } from './forms.service.js';

/**
 * Submit-path behaviour pins for FormsService: the server runs the
 * SAME form-schema validate() the browser runtime does (the
 * one-shared-evaluator promise), rejects schema-version mismatches,
 * and keeps the offline re-drain path idempotent. The paired-layer
 * mirror and the owner notification must only ever fire for
 * accepted first-writes.
 */

const LAYER_ID = '0b8f6a52-6c3e-4a57-9a43-1d2f6f1c0a11';

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
  linkedLayerId: LAYER_ID,
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

interface ItemRow {
  id: string;
  type: string;
  orgId: string;
  ownerId: string;
  access: string;
  title: string;
  tags: string[];
  deletedAt: Date | null;
  data: unknown;
}

function makeMocks(opts: {
  formData?: unknown;
  existingSubmission?: { id: string } | null;
  form?: Partial<ItemRow>;
  layer?: Partial<ItemRow> | null;
  shares?: Array<Record<string, unknown>>;
} = {}) {
  const form: ItemRow = {
    id: 'form-1',
    type: 'form',
    orgId: 'org-1',
    ownerId: 'owner-1',
    access: 'org',
    title: 'Inspection',
    tags: [],
    deletedAt: null,
    data: opts.formData ?? SCHEMA,
    ...opts.form,
  };
  const layer: ItemRow | null =
    opts.layer === null
      ? null
      : {
          id: LAYER_ID,
          type: 'data_layer',
          orgId: 'org-1',
          ownerId: 'owner-1',
          access: 'private',
          title: 'Inspection submissions',
          tags: ['form-paired'],
          deletedAt: null,
          data: {},
          ...opts.layer,
        };
  const prisma = {
    item: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === 'form-1') return form;
        if (args.where.id === LAYER_ID) return layer;
        return null;
      }),
    },
    itemShare: {
      findMany: jest.fn(async (args: { where: { itemId: string } }) =>
        (opts.shares ?? []).filter((sh) => sh.itemId === args.where.itemId),
      ),
    },
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
  const sharing = new SharingService(prisma as never, new PolicyService());
  // The form owner as the mirror's re-check sees them: a contributor
  // with no shares, so only the layer's own rules decide.
  const authSync = {
    principalForUserId: jest.fn(async (id: string) => ({
      ...makeUser(),
      id,
      username: id,
    })),
  };
  const service = new FormsService(
    prisma as unknown as ConstructorParameters<typeof FormsService>[0],
    notifications as unknown as ConstructorParameters<typeof FormsService>[1],
    dataLayerFeatures as unknown as ConstructorParameters<typeof FormsService>[2],
    dataLayerAttachments as unknown as ConstructorParameters<typeof FormsService>[3],
    sharing,
    authSync as unknown as ConstructorParameters<typeof FormsService>[5],
  );
  jest
    .spyOn((service as unknown as { log: { warn: () => void } }).log, 'warn')
    .mockImplementation(() => undefined);
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

describe('FormsService.submit access', () => {
  const expired = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);

  it('refuses a submission to a form in the trash', async () => {
    const m = makeMocks({ form: { deletedAt: new Date() } });
    await expect(m.service.submit('form-1', makeUser(), VALID_DTO)).rejects.toThrow(
      /Form not found/,
    );
    expect(m.prisma.formSubmission.upsert).not.toHaveBeenCalled();
  });

  it('refuses a private form when the only share has expired', async () => {
    const m = makeMocks({
      form: { access: 'private' },
      shares: [
        {
          itemId: 'form-1',
          principalType: 'user',
          principalId: 'user-1',
          permission: 'view',
          expiresAt: expired,
        },
      ],
    });
    await expect(m.service.submit('form-1', makeUser(), VALID_DTO)).rejects.toThrow(
      /do not have access/,
    );
    expect(m.prisma.formSubmission.upsert).not.toHaveBeenCalled();
  });

  it('accepts a private form with a live share', async () => {
    const m = makeMocks({
      form: { access: 'private' },
      shares: [
        {
          itemId: 'form-1',
          principalType: 'user',
          principalId: 'user-1',
          permission: 'view',
          expiresAt: future,
        },
      ],
    });
    await expect(m.service.submit('form-1', makeUser(), VALID_DTO)).resolves.toEqual({
      id: 'sub-1',
      created: true,
    });
  });
});

describe('FormsService.submit cleaning', () => {
  const schema = {
    schemaVersion: 1,
    id: 'form-1',
    title: 'Visibility',
    questions: [
      { id: 'kind', label: 'Kind', type: 'text' },
      {
        id: 'detail',
        label: 'Detail',
        type: 'text',
        pattern: '[0-9]+',
        visibleIf: {
          op: 'eq',
          left: { ref: 'kind' },
          right: { value: 'other' },
        },
      },
      {
        id: 'grp',
        label: 'Checks',
        type: 'group',
        repeat: {},
        children: [{ id: 'result', label: 'Result', type: 'text' }],
      },
    ],
    linkedLayerId: LAYER_ID,
  };

  it('drops hidden answers and unknown keys before storing and mirroring', async () => {
    const m = makeMocks({ formData: schema });
    await m.service.submit('form-1', makeUser(), {
      ...VALID_DTO,
      response: {
        kind: 'tree',
        // Hidden (kind is not "other") and would fail its pattern.
        detail: 'not a number',
        injected: '<script>',
        grp: [{ result: 'ok', extra: 'x' }],
      },
    });
    const stored = (
      m.prisma.formSubmission.upsert.mock.calls[0] as unknown as [
        { create: { response: Record<string, unknown> } },
      ]
    )[0].create.response;
    expect(stored).toEqual({ kind: 'tree', grp: [{ result: 'ok' }] });
    await flush();
    const props = (
      m.dataLayerFeatures.insertFeatures.mock.calls[0] as unknown as [
        string,
        string,
        Array<{ properties: Record<string, unknown> }>,
      ]
    )[2][0]!.properties;
    expect(props).not.toHaveProperty('detail');
    expect(props).not.toHaveProperty('injected');
  });
});

describe('FormsService mirror target re-check', () => {
  it('does not write into a layer in another org', async () => {
    const m = makeMocks({ layer: { orgId: 'org-2' } });
    await m.service.submit('form-1', makeUser(), VALID_DTO);
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
  });

  it('does not write into a trashed or non-layer target', async () => {
    const trashed = makeMocks({ layer: { deletedAt: new Date() } });
    await trashed.service.submit('form-1', makeUser(), VALID_DTO);
    const notLayer = makeMocks({ layer: { type: 'map' } });
    await notLayer.service.submit('form-1', makeUser(), VALID_DTO);
    await flush();
    expect(trashed.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
    expect(notLayer.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
  });

  it('does not write into a linked layer the form owner cannot edit', async () => {
    const m = makeMocks({
      layer: { tags: [], ownerId: 'someone-else', access: 'org' },
    });
    await m.service.submit('form-1', makeUser(), VALID_DTO);
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
  });

  it('writes into a linked layer the form owner can edit', async () => {
    const m = makeMocks({
      layer: { tags: [], ownerId: 'someone-else', access: 'org' },
      shares: [
        {
          itemId: LAYER_ID,
          principalType: 'user',
          principalId: 'owner-1',
          permission: 'edit',
          expiresAt: null,
        },
      ],
    });
    await m.service.submit('form-1', makeUser(), VALID_DTO);
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).toHaveBeenCalled();
  });

  it('does not write into a form-paired layer after the form owner lost edit on it', async () => {
    // B had edit on A's paired layer, linked their own form to it, and
    // A then revoked the share. The layer still carries the tag.
    const m = makeMocks({
      form: { ownerId: 'user-b' },
      layer: { ownerId: 'user-a', tags: ['form-paired'], access: 'private' },
      shares: [],
    });
    await m.service.submit('form-1', makeUser(), VALID_DTO);
    await flush();
    expect(m.dataLayerFeatures.insertFeatures).not.toHaveBeenCalled();
  });
});
