// SPDX-License-Identifier: AGPL-3.0-or-later
import { textEnv } from '../common/env.js';

/** Default trash retention, matching docs/soft-delete.md. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * Days a trashed item or group is kept before the purge job removes
 * it, from RECYCLE_BIN_RETENTION_DAYS. Null when the setting is not a
 * usable number, in which case the purge job skips its run.
 *
 * One reader for the purge job and for /users/me, so the delete
 * dialogs promise the window the purge actually uses (they said 30
 * whatever the operator set).
 */
export function trashRetentionDays(raw: string | undefined): number | null {
  const days = Number(textEnv(raw, String(DEFAULT_TRASH_RETENTION_DAYS)));
  return Number.isFinite(days) && days >= 1 ? days : null;
}
