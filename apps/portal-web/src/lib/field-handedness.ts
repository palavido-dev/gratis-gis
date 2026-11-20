// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which side of the screen the field app puts its thumb controls on
 * (the + collect button and Locate), for one-handed use (#772).
 *
 * Stored per device, not per account: it describes how this person
 * holds this phone. Browser storage can be missing or throw (private
 * mode, storage blocked), so every access is guarded and the default
 * is the right side.
 */
export type Handedness = 'right' | 'left';

export const HANDEDNESS_STORAGE_KEY = 'gratis-gis:field:handedness';

export function parseHandedness(value: unknown): Handedness {
  return value === 'left' ? 'left' : 'right';
}

export function readHandedness(storage: Pick<Storage, 'getItem'> | undefined): Handedness {
  try {
    return parseHandedness(storage?.getItem(HANDEDNESS_STORAGE_KEY));
  } catch {
    return 'right';
  }
}

export function writeHandedness(
  storage: Pick<Storage, 'setItem'> | undefined,
  value: Handedness,
): void {
  try {
    storage?.setItem(HANDEDNESS_STORAGE_KEY, value);
  } catch {
    // Not saved. The choice still applies until the page reloads.
  }
}
