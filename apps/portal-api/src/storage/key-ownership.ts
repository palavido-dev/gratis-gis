// SPDX-License-Identifier: AGPL-3.0-or-later
import { HttpException, HttpStatus } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { AssetKind } from './storage.service.js';

/**
 * Ownership of client-supplied storage keys.
 *
 * `asset-keys.ts` pins a key to its kind's prefix. That stops a key
 * from crossing prefixes, but not from crossing items: item data
 * (`storageKey`, `cogStorageKey`) and attachment URLs reach every
 * reader, so a reader could copy another item's key into an item they
 * own, then delete the object through purge, finalize or attachment
 * remove, or republish it through a public item.
 *
 * Two rules close that, and every place a key enters or leaves goes
 * through them:
 *
 *   1. A key is attachable only when the caller was issued it by
 *      presign (a `storage_upload_grant` row) or the target already
 *      references it (an unchanged key on a re-save, a rebuild over
 *      sources already registered).
 *   2. An object is deleted only when no other item or attachment row
 *      still references its key.
 */

/** Kinds whose keys clients hand back to attach paths. */
export const GRANTED_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  'feature-attachment',
  'item-file',
  // The asset picker's File items name an item-thumb key in
  // data.publicImageKey, which purge deletes.
  'item-thumb',
  'item-tile-layer',
  'item-point-cloud',
]);

const GRANT_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** Kinds whose presigned PUT may be gigabytes (8 GB each). */
export const LARGE_UPLOAD_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  'item-tile-layer',
  'item-point-cloud',
]);

/** Large-upload URLs one user may hold open at a time. */
export const MAX_OPEN_LARGE_GRANTS = 4;

/** How long a presigned PUT stays usable (StorageService signs 600 s). */
const PRESIGN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Refuse a large-upload presign when the caller already holds
 * MAX_OPEN_LARGE_GRANTS that could still be used. Without a cap any
 * signed-in account could loop presign and PUT and fill the object
 * store, 8 GB at a time.
 */
export async function assertLargeGrantRoom(
  prisma: PrismaService,
  kind: AssetKind,
  userId: string,
): Promise<void> {
  if (!LARGE_UPLOAD_KINDS.has(kind)) return;
  const open = await prisma.storageUploadGrant.count({
    where: {
      userId,
      createdAt: { gte: new Date(Date.now() - PRESIGN_WINDOW_MS) },
      OR: [...LARGE_UPLOAD_KINDS].map((k) => ({ key: { startsWith: `${k}/` } })),
    },
  });
  if (open >= MAX_OPEN_LARGE_GRANTS) {
    throw new HttpException(
      `You already have ${open} large uploads in progress. Finish or wait for them before starting another.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Record that `userId` was issued `key` by presign. */
export async function recordUploadGrant(
  prisma: PrismaService,
  kind: AssetKind,
  key: string,
  userId: string,
): Promise<void> {
  if (!GRANTED_KINDS.has(kind)) return;
  await prisma.storageUploadGrant.create({ data: { key, userId } });
  // A presigned PUT lives ten minutes at most and the attach follows
  // the upload, so old grants only matter as history. Prune them here
  // rather than adding a cron. Best effort.
  await prisma.storageUploadGrant
    .deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - GRANT_TTL_MS) } },
    })
    .catch(() => undefined);
}

/**
 * Refuse any key in `keys` that the caller was not issued and that
 * `current` (keys the target already references) does not contain.
 */
export async function assertKeysAttachable(
  prisma: PrismaService,
  userId: string,
  keys: Iterable<string | null | undefined>,
  current: Iterable<string | null | undefined> = [],
): Promise<void> {
  const have = new Set<string>();
  for (const k of current) if (typeof k === 'string' && k) have.add(k);
  const wanted = [
    ...new Set(
      [...keys].filter(
        (k): k is string => typeof k === 'string' && k.length > 0 && !have.has(k),
      ),
    ),
  ];
  if (wanted.length === 0) return;
  const granted = await prisma.storageUploadGrant.findMany({
    where: { key: { in: wanted }, userId },
    select: { key: true },
  });
  const ok = new Set(granted.map((g) => g.key));
  if (wanted.some((k) => !ok.has(k))) {
    // One message for "not yours" and "does not exist": the caller
    // should not learn which keys belong to someone else.
    throw new BadRequestException(
      'That upload was not issued to you. Upload the file again and retry.',
    );
  }
}

/**
 * True when an item or feature attachment other than the excepted
 * ones references `key`. Trashed items count: they can be restored.
 */
export async function isKeyReferencedElsewhere(
  prisma: PrismaService,
  key: string,
  except: { itemId?: string | null; attachmentId?: string | null } = {},
): Promise<boolean> {
  const none = '00000000-0000-0000-0000-000000000000';
  const itemId = except.itemId ?? none;
  const attachmentId = except.attachmentId ?? none;
  // @> containment so the item_data_gin (jsonb_path_ops) index serves
  // the item side.
  const rows = await prisma.$queryRaw<{ found: boolean }[]>(Prisma.sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM item
         WHERE id <> ${itemId}::uuid
           AND (
             storage_ref = ${key}
             OR data_json @> jsonb_build_object('storageKey', ${key}::text)
             OR data_json @> jsonb_build_object('cogStorageKey', ${key}::text)
             OR data_json @> jsonb_build_object('pmtilesStorageKey', ${key}::text)
             OR data_json @> jsonb_build_object('publicImageKey', ${key}::text)
             OR data_json @> jsonb_build_object(
                  'sources',
                  jsonb_build_array(jsonb_build_object('storageKey', ${key}::text))
                )
           )
      )
      OR EXISTS (
        SELECT 1 FROM feature_attachment
         WHERE storage_key = ${key}
           AND id <> ${attachmentId}::uuid
      )
    ) AS found
  `);
  return rows[0]?.found === true;
}

/**
 * Delete `key` unless another row still references it. Returns true
 * when the delete ran.
 */
export async function deleteIfUnreferenced(
  prisma: PrismaService,
  storage: { deleteObject(key: string): Promise<unknown> },
  key: string,
  except: { itemId?: string | null; attachmentId?: string | null } = {},
): Promise<boolean> {
  if (await isKeyReferencedElsewhere(prisma, key, except)) return false;
  await storage.deleteObject(key);
  return true;
}
