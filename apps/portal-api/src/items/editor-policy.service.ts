import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { ItemsService } from './items.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Defense-in-depth check for the Editor item's per-target policy.
 *
 * The Editor's runtime UI restricts writes based on the configured
 * target (canCreate, canEditAttributes, canEditGeometry, canDelete,
 * editableFields). Without a server-side gate, a malicious client
 * could bypass the UI and hit the v3 features endpoint directly --
 * the existing share-edit check on the data_layer would let them
 * through if they had any direct write share, regardless of the
 * Editor's stricter rules.
 *
 * This service runs when the runtime sends an `x-editor-id` header
 * with a write request. It loads the Editor item (auth via
 * ItemsService.get, so the caller must have access), finds the
 * matching target, and rejects ops the target forbids. When the
 * header is absent we skip entirely -- direct hits on the v3
 * endpoints continue to be governed by the data_layer's existing
 * share-edit check, unchanged.
 *
 * Future work: when an Editor share is wired to grant write access
 * to users WITHOUT a direct data_layer share (today they can't
 * write at all), this service is the natural place to drive the
 * "yes, let them in via this Editor" check.
 */
@Injectable()
export class EditorPolicyService {
  constructor(private readonly items: ItemsService) {}

  async assertAllows(args: {
    user: AuthUser;
    editorId: string;
    dataLayerId: string;
    layerKey: string;
    op: 'create' | 'update' | 'delete';
    /** PATCH-only: which kinds of changes the body carries. Used to
     *  pick between canEditGeometry vs canEditAttributes plus the
     *  editableFields key check. Ignored for create/delete. */
    patchKinds?: {
      hasGeometry: boolean;
      propertyKeys: string[];
    };
  }): Promise<void> {
    const editor = await this.items.get(args.user, args.editorId);
    if (editor.type !== 'editor') {
      // Same response as "you can't see this": treating type-mismatch
      // as not-found avoids leaking the existence of an Editor item
      // pointed at the wrong layer.
      throw new NotFoundException('Editor not found');
    }
    const data = (editor.data ?? {}) as {
      targets?: Array<{
        dataLayerId: string;
        layerKey: string;
        canCreate?: boolean;
        canEditGeometry?: boolean;
        canEditAttributes?: boolean;
        canDelete?: boolean;
        editableFields?: string[] | null;
      }>;
    };
    const target = (data.targets ?? []).find(
      (t) => t.dataLayerId === args.dataLayerId && t.layerKey === args.layerKey,
    );
    if (!target) {
      throw new ForbiddenException(
        'This Editor does not target the requested layer.',
      );
    }

    if (args.op === 'create') {
      if (!target.canCreate) {
        throw new ForbiddenException(
          'This Editor does not allow creating features on this layer.',
        );
      }
      return;
    }
    if (args.op === 'delete') {
      if (!target.canDelete) {
        throw new ForbiddenException(
          'This Editor does not allow deleting features on this layer.',
        );
      }
      return;
    }
    // op === 'update'. Pick the stricter of the two attribute /
    // geometry rules based on what the body includes. A PATCH that
    // touches both must satisfy both flags.
    const kinds = args.patchKinds ?? { hasGeometry: false, propertyKeys: [] };
    if (kinds.hasGeometry && !target.canEditGeometry) {
      throw new ForbiddenException(
        'This Editor does not allow geometry edits on this layer.',
      );
    }
    if (kinds.propertyKeys.length > 0) {
      if (!target.canEditAttributes) {
        throw new ForbiddenException(
          'This Editor does not allow attribute edits on this layer.',
        );
      }
      if (target.editableFields !== null && target.editableFields !== undefined) {
        const allowed = new Set(target.editableFields);
        for (const k of kinds.propertyKeys) {
          if (!allowed.has(k)) {
            throw new ForbiddenException(
              `Field "${k}" is not editable through this Editor.`,
            );
          }
        }
      }
    }
  }
}
