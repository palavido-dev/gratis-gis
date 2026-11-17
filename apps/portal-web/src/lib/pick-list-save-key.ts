// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PickListData } from '@gratis-gis/shared-types';

/**
 * A comparable fingerprint of what the pick list editor would save:
 * entries trimmed the way save() trims them, plus the note. Two
 * drafts with the same key save the same thing, so the editor is
 * dirty exactly when the key differs from the last saved one.
 */
export function pickListSaveKey(data: PickListData): string {
  return JSON.stringify({
    note: data.note ?? null,
    entries: (data.entries ?? []).map((e) => [
      e.code.trim(),
      e.label.trim(),
      e.description?.trim() ?? '',
    ]),
  });
}
