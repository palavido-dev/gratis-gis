// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's `data` when `type = 'web_app'`.
 *
 * #258: web_app is the umbrella type for "templated app on top of an
 * item". When the data carries a `template` discriminator + a
 * `config` object whose shape is the template's, downstream code
 * routes to template-specific UI / endpoints. See
 * docs/item-type-guidance.md for the decision pattern.
 *
 * Today the registry is small (just `editor`); future templates
 * (Dashboard, Survey-response viewer, Story map) plug in by adding
 * a discriminator value here + a config sub-shape.
 *
 * Untemplated `web_app` items (no `template` field) keep working as
 * a freeform external-link surface. The detail UI shows a generic
 * "open" affordance.
 */

import type { CustomAppData } from './custom-app';
import type { EditorData } from './editor';
import type { ViewerData } from './viewer';

/**
 * Tag of which template a web_app implements. Each value pairs with
 * a config sub-shape in WebAppData.config. Adding a value: extend
 * this union and the WebAppData['config'] discriminated branch.
 *
 * Note: the `survey` template was folded into the Form item type
 * (#91); the Form designer's Responses tab now configures what was
 * previously a Survey app, and every form's submissions are visible
 * at `/items/<formId>/responses` without a wrapping web_app item.
 */
export type WebAppTemplate = 'editor' | 'viewer' | 'custom';

/**
 * Top-level shape on a web_app's `data` field.
 *
 * Versioned for forward-compat: the field is optional today, and
 * older web_app rows that never carried a `version` keep working.
 * Bumping `version` lets us introduce migrators on read.
 */
export interface WebAppData {
  /** Optional schema version; bump on breaking shape changes. */
  version?: 1;
  /**
   * Which template this web_app implements. When unset, the item is
   * a generic "external link" web app and `config` is ignored.
   */
  template?: WebAppTemplate;
  /**
   * Template-specific configuration. The shape depends on
   * `template`; consumers should narrow via the discriminator
   * before reading nested fields.
   */
  config?: WebAppConfig;
  /**
   * Backward-compat catch-all for the historic "external URL" web_app
   * shape: a simple string the detail UI opens in a new tab. Kept on
   * the top level so older items render unchanged. New templated
   * web_apps don't use this.
   */
  url?: string;
}

/**
 * Discriminated union of every template's config shape. Add a new
 * branch when introducing a new template.
 */
export type WebAppConfig =
  | { template: 'editor'; editor: EditorData }
  | { template: 'viewer'; viewer: ViewerData }
  | { template: 'custom'; custom: CustomAppData }
  | { template: string; [key: string]: unknown };

/**
 * Type guard: was this item created or migrated as the editor
 * template? Pulls the editor config or returns null.
 *
 * Accepts the broad `Item` shape (not narrowed to a generic) so the
 * helper can be reused on ItemWithShares, list rows, etc. Backward
 * compat: still recognizes the legacy top-level `type === 'editor'`
 * during the deprecation window so any not-yet-migrated rows surface
 * the same way as migrated ones.
 */
export function isEditorItem(item: {
  type: string;
  data?: unknown;
}): boolean {
  if (item.type === 'editor') return true;
  if (item.type !== 'web_app') return false;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template === 'editor') return true;
  // Tolerance branch: a web_app item whose data is an unwrapped
  // EditorData (the legacy detail-page save before the WebAppData
  // wrapper preservation fix) has no `template` field but DOES have
  // EditorData's structural markers. Treat it as an editor item so
  // the runtime + dispatch keep working. The one-time data
  // migration 20260505030000_rewrap_webapp_data rewrapped the rows
  // that existed when it was applied; Prisma migrations do not
  // rerun, so any row written in the legacy shape after that point
  // stays unwrapped until something rewrites it. This branch is
  // that permanent tolerance.
  if (
    d &&
    typeof d === 'object' &&
    !('template' in d) &&
    'targets' in d &&
    'snapping' in d
  ) {
    return true;
  }
  return false;
}

/**
 * Read the EditorData out of either layout: a legacy editor item
 * (data is EditorData directly) or a migrated web_app+editor item
 * (data is WebAppData with config.editor). Returns null when the
 * item isn't an editor (or when the data is missing/malformed).
 *
 * Centralizing this read so callers don't sprinkle their own
 * "is it the legacy shape or the new shape" checks across the
 * codebase. Once the deprecation window closes and we drop the
 * legacy branch, this is the single place to update.
 */
export function readEditorData(item: {
  type: string;
  data?: unknown;
}): EditorData | null {
  if (item.type === 'editor') {
    return (item.data as EditorData | null | undefined) ?? null;
  }
  if (item.type !== 'web_app') return null;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template === 'editor') {
    // Canonical wrapped shape.
    const cfg = d.config as
      | { template: 'editor'; editor?: EditorData }
      | null
      | undefined;
    if (cfg?.template === 'editor' && cfg.editor) return cfg.editor;
    // Older partial-migration tolerance: config IS the EditorData.
    if (cfg && typeof cfg === 'object' && 'targets' in cfg) {
      return cfg as unknown as EditorData;
    }
    return null;
  }
  // Tolerance branch: web_app item whose data is unwrapped EditorData
  // (pre-fix detail-page save). Detected by EditorData's structural
  // markers (`targets` + `snapping`); ViewerData lacks `snapping` so
  // it's distinguishable from the viewer fallback in readViewerData.
  if (
    d &&
    typeof d === 'object' &&
    !('template' in d) &&
    'targets' in d &&
    'snapping' in d
  ) {
    return d as unknown as EditorData;
  }
  return null;
}

/**
 * Type guard: was this item created as the viewer (Read-Only Viewer)
 * template? Mirrors isEditorItem; no legacy top-level `type='viewer'`
 * to support since the viewer template never existed pre-#258.
 *
 * Accepts the broad `Item` shape (not narrowed to a generic) so the
 * helper can be reused on ItemWithShares, list rows, etc.
 */
export function isViewerItem(item: {
  type: string;
  data?: unknown;
}): boolean {
  if (item.type !== 'web_app') return false;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template === 'viewer') return true;
  // Tolerance branch: web_app item whose data is unwrapped ViewerData
  // (pre-fix detail-page save stripped the WebAppData wrapper). The
  // one-time 20260505030000 migration rewrapped the rows that
  // existed when it ran; migrations do not rerun, so rows written
  // in the legacy shape afterwards rely on this branch permanently.
  // ViewerData has `targets` + `tools` but no `snapping`, which is
  // how we distinguish it from an unwrapped EditorData.
  if (
    d &&
    typeof d === 'object' &&
    !('template' in d) &&
    'targets' in d &&
    'tools' in d &&
    !('snapping' in d)
  ) {
    return true;
  }
  return false;
}

/**
 * Read the ViewerData out of a web_app+viewer item. Returns null
 * when the item isn't a viewer (or when the data is missing /
 * malformed). Mirrors readEditorData.
 */
export function readViewerData(item: {
  type: string;
  data?: unknown;
}): ViewerData | null {
  if (item.type !== 'web_app') return null;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template === 'viewer') {
    // Canonical wrapped shape.
    const cfg = d.config as
      | { template: 'viewer'; viewer?: ViewerData }
      | null
      | undefined;
    if (cfg?.template === 'viewer' && cfg.viewer) return cfg.viewer;
    // Older partial-migration tolerance: config IS the ViewerData.
    if (cfg && typeof cfg === 'object' && 'targets' in cfg) {
      return cfg as unknown as ViewerData;
    }
    return null;
  }
  // Tolerance branch: web_app item whose data is unwrapped ViewerData
  // (matches the same shape detection isViewerItem uses).
  if (
    d &&
    typeof d === 'object' &&
    !('template' in d) &&
    'targets' in d &&
    'tools' in d &&
    !('snapping' in d)
  ) {
    return d as unknown as ViewerData;
  }
  return null;
}

/**
 * Type guard: was this item created as the `custom` Web App template
 * (#261)? Mirrors isViewerItem. CustomAppData carries `pages` (an
 * array) which is its primary structural marker; an unwrapped
 * CustomAppData is detectable by the presence of `pages` without the
 * `targets` + `tools` Viewer/Editor combination.
 */
export function isCustomAppItem(item: {
  type: string;
  data?: unknown;
}): boolean {
  if (item.type !== 'web_app') return false;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template === 'custom') return true;
  if (
    d &&
    typeof d === 'object' &&
    !('template' in d) &&
    'pages' in d &&
    Array.isArray((d as { pages?: unknown }).pages)
  ) {
    return true;
  }
  return false;
}

/**
 * Read the CustomAppData out of a web_app+custom item. Returns null
 * when the item isn't a custom app or when the data is missing /
 * malformed. Mirrors readViewerData.
 */
export function readCustomAppData(item: {
  type: string;
  data?: unknown;
}): CustomAppData | null {
  if (item.type !== 'web_app') return null;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template === 'custom') {
    const cfg = d.config as
      | { template: 'custom'; custom?: CustomAppData }
      | null
      | undefined;
    if (cfg?.template === 'custom' && cfg.custom) return cfg.custom;
    if (cfg && typeof cfg === 'object' && 'pages' in cfg) {
      return cfg as unknown as CustomAppData;
    }
    return null;
  }
  if (
    d &&
    typeof d === 'object' &&
    !('template' in d) &&
    'pages' in d &&
    Array.isArray((d as { pages?: unknown }).pages)
  ) {
    return d as unknown as CustomAppData;
  }
  return null;
}
