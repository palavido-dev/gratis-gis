// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Item editors PATCH the whole `data` blob, so without a version
 * check the later of two saves silently reverts the other. portal-api
 * refuses a PATCH whose `expectedUpdatedAt` is no longer the item's
 * `updatedAt` with 409. These helpers send the version the editor
 * loaded and move it forward after each successful save.
 */

/** Add `expectedUpdatedAt` to a PATCH body when a version is known. */
export function withExpectedUpdatedAt<T extends object>(
  body: T,
  updatedAt: string | null | undefined,
): T & { expectedUpdatedAt?: string } {
  return typeof updatedAt === 'string' && updatedAt.length > 0
    ? { ...body, expectedUpdatedAt: updatedAt }
    : body;
}

/** True when the server refused a save because the item changed. */
export function isStaleItemSave(res: Response): boolean {
  return res.status === 409;
}

/** The `updatedAt` a successful PATCH response reports, if any. */
export async function savedUpdatedAt(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { updatedAt?: unknown } | null;
    return typeof body?.updatedAt === 'string' ? body.updatedAt : null;
  } catch {
    return null;
  }
}

/**
 * PATCH an item guarded by the version the editor loaded. Returns the
 * Response; check `isStaleItemSave(res)` before `res.ok`. On success
 * the held version moves to the saved one, so the next save from the
 * same editor is not refused by its own previous write.
 */
export function useGuardedItemPatch(
  itemId: string,
  updatedAt: string | null | undefined,
): (body: object) => Promise<Response> {
  const version = useRef<string | null>(updatedAt ?? null);
  useEffect(() => {
    if (typeof updatedAt === 'string') version.current = updatedAt;
  }, [updatedAt]);
  return useCallback(
    async (body: object) => {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withExpectedUpdatedAt(body, version.current)),
      });
      if (res.ok) {
        const next = await savedUpdatedAt(res);
        if (next) version.current = next;
      }
      return res;
    },
    [itemId],
  );
}
