// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Form patterns are matched with RE2 inside @gratis-gis/form-schema
 * (see its pattern.ts). The save-time check uses the same compiler so
 * a pattern the validator cannot run is refused when the form is saved.
 */
export { compileAnchoredPattern as compileLinearPattern } from '@gratis-gis/form-schema';
