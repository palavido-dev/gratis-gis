// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { ItemsService } from './items.service.js';

/**
 * A form's `linkedLayerId` names the layer its submissions are
 * written into, by whoever submits. It used to be taken from the
 * client unchecked on both create and update, so any contributor
 * could point a form at another org's layer and write rows into it
 * by submitting to their own form. Linking now needs edit on a live
 * data layer in the form's own org.
 */

const FORM_ID = '00000000-0000-4000-8000-0000000000f1';
const OWN_LAYER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG_LAYER = '00000000-0000-4000-8000-0000000000b1';
const READ_ONLY_LAYER = '00000000-0000-4000-8000-0000000000c1';

function makeUser(): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'ana',
    email: 'ana@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(['can_publish_items']),
  } as unknown as AuthUser;
}

function row(id: string, over: Record<string, unknown>) {
  return {
    id,
    orgId: 'org-1',
    ownerId: 'user-1',
    type: 'data_layer',
    title: 't',
    description: '',
    tags: [],
    access: 'private',
    data: {},
    deletedAt: null,
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    thumbnailUrl: null,
    thumbnailDesign: null,
    shares: [],
    owner: null,
    ...over,
  };
}

const ROWS: Record<string, ReturnType<typeof row>> = {
  [FORM_ID]: row(FORM_ID, {
    type: 'form',
    data: {
      schemaVersion: 1,
      questions: [],
      linkedLayerId: OWN_LAYER,
      linkedLayerKey: 'submissions',
    },
  }),
  [OWN_LAYER]: row(OWN_LAYER, {}),
  [OTHER_ORG_LAYER]: row(OTHER_ORG_LAYER, { orgId: 'org-2', ownerId: 'x', access: 'public' }),
  [READ_ONLY_LAYER]: row(READ_ONLY_LAYER, { ownerId: 'someone', access: 'org' }),
};

function makeService() {
  const prisma: Record<string, unknown> & {
    item: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  } = {
    item: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ROWS[where.id] ?? null),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => ROWS[where.id] ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        row(FORM_ID, { ...data, type: 'form' }),
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        row(FORM_ID, { ...data, type: 'form' }),
      ),
    },
    itemShare: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma)),
    $queryRaw: jest.fn(async () => [
      {
        data: ROWS[FORM_ID]!.data,
        updated_at: ROWS[FORM_ID]!.updatedAt,
        // lockItemRow reads the row's updated_at as epoch ms.
        updated_at_ms: ROWS[FORM_ID]!.updatedAt.getTime(),
      },
    ]),
  };
  const sharing = new SharingService(prisma as never, new PolicyService());
  const svc = new ItemsService(
    prisma as never,
    sharing,
    {} as never,
    { snapshot: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma };
}

const formData = (layerId: string) => ({
  schemaVersion: 1,
  questions: [],
  linkedLayerId: layerId,
  linkedLayerKey: 'submissions',
});

describe('form linkedLayerId on create', () => {
  it('refuses a layer in another org', async () => {
    const { svc, prisma } = makeService();
    await expect(
      svc.create(makeUser(), { type: 'form', title: 'F', data: formData(OTHER_ORG_LAYER) } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.item.create).not.toHaveBeenCalled();
  });

  it('refuses a same-org layer the caller cannot edit', async () => {
    const { svc, prisma } = makeService();
    await expect(
      svc.create(makeUser(), { type: 'form', title: 'F', data: formData(READ_ONLY_LAYER) } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.item.create).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a uuid', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(makeUser(), { type: 'form', title: 'F', data: formData('nope') } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a layer the caller can edit', async () => {
    const { svc, prisma } = makeService();
    await svc.create(makeUser(), { type: 'form', title: 'F', data: formData(OWN_LAYER) } as never);
    expect(prisma.item.create).toHaveBeenCalled();
  });
});

describe('form linkedLayerId on update', () => {
  it('refuses moving the link to a layer in another org', async () => {
    const { svc, prisma } = makeService();
    await expect(
      svc.update(makeUser(), FORM_ID, { data: formData(OTHER_ORG_LAYER) } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it('keeps the stored link when the client omits it', async () => {
    const { svc, prisma } = makeService();
    await svc.update(makeUser(), FORM_ID, {
      data: { schemaVersion: 1, questions: [] },
    } as never);
    const written = (
      prisma.item.update.mock.calls[0] as unknown as [{ data: { data: Record<string, unknown> } }]
    )[0].data.data;
    expect(written.linkedLayerId).toBe(OWN_LAYER);
  });

  it('removes the link when the client sends linkedLayerId null (Unlink)', async () => {
    const { svc, prisma } = makeService();
    await svc.update(makeUser(), FORM_ID, {
      data: { schemaVersion: 1, questions: [], linkedLayerId: null, linkedLayerKey: null },
    } as never);
    const written = (
      prisma.item.update.mock.calls[0] as unknown as [{ data: { data: Record<string, unknown> } }]
    )[0].data.data;
    expect('linkedLayerId' in written).toBe(false);
    expect('linkedLayerKey' in written).toBe(false);
  });

  it('accepts re-sending the same link without a layer check', async () => {
    const { svc, prisma } = makeService();
    await svc.update(makeUser(), FORM_ID, { data: formData(OWN_LAYER) } as never);
    expect(prisma.item.findFirst).not.toHaveBeenCalled();
    expect(prisma.item.update).toHaveBeenCalled();
  });
});
