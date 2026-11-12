// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import { EditorPolicyService } from './editor-policy.service.js';
import type { ItemsService } from './items.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

const user = { id: 'u1' } as unknown as AuthUser;

function serviceWith(rowScope: 'all' | 'own'): EditorPolicyService {
  const items = {
    get: jest.fn().mockResolvedValue({
      type: 'editor',
      data: {
        targets: [
          {
            dataLayerId: 'dl',
            layerKey: 'layer-1',
            canCreate: true,
            canEditAttributes: true,
            canEditGeometry: true,
            canDelete: true,
            editableFields: null,
            rowScope,
            templates: [],
          },
        ],
      },
    }),
  } as unknown as ItemsService;
  return new EditorPolicyService(items);
}

const base = { user, editorId: 'ed', dataLayerId: 'dl', layerKey: 'layer-1' };

describe('EditorPolicyService row scope', () => {
  it('reports own-rows for update and delete when the target says so', async () => {
    const svc = serviceWith('own');
    await expect(
      svc.assertAllows({
        ...base,
        op: 'update',
        patchKinds: { hasGeometry: false, propertyKeys: ['status'] },
      }),
    ).resolves.toEqual({ ownRowsOnly: true });
    await expect(svc.assertAllows({ ...base, op: 'delete' })).resolves.toEqual({
      ownRowsOnly: true,
    });
  });

  it('never narrows create, and leaves all-rows targets alone', async () => {
    await expect(
      serviceWith('own').assertAllows({ ...base, op: 'create' }),
    ).resolves.toEqual({ ownRowsOnly: false });
    await expect(
      serviceWith('all').assertAllows({ ...base, op: 'delete' }),
    ).resolves.toEqual({ ownRowsOnly: false });
  });

  it('still refuses a layer the Editor does not target', async () => {
    await expect(
      serviceWith('all').assertAllows({ ...base, layerKey: 'other', op: 'delete' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
