// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads the New item wizard's `?type=` deep-link value.
//
// The old ArcGIS, WMS and WFS service item types are deprecated. No
// link in the app points at them any more, but a hand-typed or
// bookmarked `?type=arcgis_service` used to open their old wizard
// panes and create the deprecated types. The Connected service type
// detects all three protocols from the URL, so those values now land
// there instead.

/** Deprecated `?type=` values that open the Connected service flow. */
export const LEGACY_SERVICE_TYPE_PARAMS = [
  'arcgis_service',
  'wms_service',
  'wfs_service',
] as const;

/** Wizard-only sentinels that are not persisted item types. */
const WIZARD_SENTINELS = ['viewer', 'custom'] as const;

export type WizardTypeParam<T extends string> =
  | T
  | (typeof WIZARD_SENTINELS)[number];

/**
 * Maps a raw `?type=` value to the wizard type to open, or null when
 * the value is missing or unknown. `itemTypes` is the known item type
 * list, passed in so this module stays free of app imports.
 */
export function wizardTypeFromParam<T extends string>(
  raw: string | null | undefined,
  itemTypes: readonly T[],
): WizardTypeParam<T> | null {
  const value = raw ?? '';
  if (!value) return null;
  const sentinel = WIZARD_SENTINELS.find((s) => s === value);
  if (sentinel) return sentinel;
  if ((LEGACY_SERVICE_TYPE_PARAMS as readonly string[]).includes(value)) {
    return (itemTypes as readonly string[]).includes('service')
      ? ('service' as T)
      : null;
  }
  return (itemTypes as readonly string[]).includes(value) ? (value as T) : null;
}

/** True when `raw` is a deprecated value that should be rewritten. */
export function isLegacyServiceTypeParam(
  raw: string | null | undefined,
): boolean {
  return (LEGACY_SERVICE_TYPE_PARAMS as readonly string[]).includes(raw ?? '');
}
