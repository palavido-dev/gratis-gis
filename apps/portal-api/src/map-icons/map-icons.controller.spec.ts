// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { MAX_ICONS_PER_ORG, MapIconsController } from './map-icons.controller.js';

function user(role: 'viewer' | 'contributor'): AuthUser {
  return {
    id: 'u1',
    orgId: 'org-1',
    orgRole: role,
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES[role]),
  } as unknown as AuthUser;
}

const svg = {
  mimetype: 'image/svg+xml',
  originalname: 'pin.svg',
  size: 60,
  buffer: Buffer.from('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'),
} as Express.Multer.File;

function controller(count: number) {
  const prisma = {
    mapIconUpload: {
      count: jest.fn(async () => count),
      create: jest.fn(async () => ({
        id: 'i1',
        storageKey: 'k',
        storageUrl: 'u',
        label: 'pin',
        fileName: 'pin.svg',
        sizeBytes: 1,
        createdAt: new Date(),
      })),
    },
  };
  const storage = { uploadBuffer: jest.fn(async () => ({ key: 'k', publicUrl: 'u' })) };
  return {
    c: new MapIconsController(prisma as never, storage as never),
    storage,
  };
}

describe('MapIconsController upload gate', () => {
  it('refuses a viewer', async () => {
    const { c, storage } = controller(0);
    await expect(c.upload(user('viewer'), svg, {} as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('refuses past the per-org cap', async () => {
    const { c } = controller(MAX_ICONS_PER_ORG);
    await expect(c.upload(user('contributor'), svg, {} as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a contributor under the cap', async () => {
    const { c, storage } = controller(3);
    await expect(c.upload(user('contributor'), svg, {} as never)).resolves.toMatchObject({
      id: 'i1',
    });
    expect(storage.uploadBuffer).toHaveBeenCalled();
  });
});
