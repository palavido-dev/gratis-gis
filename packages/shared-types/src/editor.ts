/**
 * Canonical shape stored in an Item's dataJson when `type = 'editor'`.
 *
 * An Editor is an online, tool-driven workspace for creating, editing,
 * and deleting features against one or more data_layer items. It pairs
 * with the data_collection item type (form-driven, offline-capable
 * field capture) to replace Esri's sprawling Map-Viewer-edits /
 * Survey123 / Field Maps / Workforce surfaces with two concise items
 * each owning one workflow.
 *
 * See docs/editing-and-collection.md for the full design.
 *
 * Authorization is conjunctive and never escalating:
 *   1. data_layer.editing.policy gates whether the layer is editable
 *      at all.
 *   2. The Editor item config (this shape) narrows from there: drop
 *      fields, lock geometry, restrict row scope further.
 *   3. The share grant on the Editor item narrows per recipient.
 *   4. Geo limits on shares clip rows to a polygon.
 *
 * Versioned for forward compatibility: bump `version` and write a
 * migrator when a breaking change is needed. The runtime should
 * tolerate missing fields and fall back to defaults so older Editor
 * items keep rendering after additive shape changes.
 */

export interface EditorData {
  version: 1;
  /**
   * Optional reference to a `map` item. When set, the editor's
   * canvas inherits that map's basemap, viewport, and symbology.
   * When unset, the editor renders a minimal default basemap and
   * fits the camera to the union of its target layers' extents.
   */
  mapId?: string;
  /**
   * Layers exposed for editing in this Editor. Each entry references
   * a layer inside a data_layer item (by `dataLayerId` + `layerKey`)
   * and declares the per-layer editing policy. The Editor can
   * never grant capabilities the underlying data_layer does not
   * already allow; this list narrows from there.
   */
  targets: EditorTarget[];
  /**
   * Tool palette enabled for this editor. The runtime only renders
   * tools in this list. Editors with a narrow purpose (e.g. "fix
   * attribute typos only") can drop drawing tools entirely.
   */
  tools: EditorTool[];
  /** Snap settings shared across drawing tools. */
  snapping: EditorSnapping;
}

/**
 * One editable layer in the editor. References the layer by id +
 * key (matching v3 multi-layer data_layer items). All `can*` flags
 * are conjunctive against the underlying data_layer's editing.policy:
 * a layer with policy='none' ignores any `canEdit*` here.
 */
export interface EditorTarget {
  /** Item id of the data_layer this target lives in. */
  dataLayerId: string;
  /**
   * Key identifying which layer inside the data_layer this target
   * refers to. Matches the v3 layer key in the data_layer's
   * `data.layers[].key`.
   */
  layerKey: string;
  /** Whether users can create new features. */
  canCreate: boolean;
  /** Whether users can change geometry on existing features. */
  canEditGeometry: boolean;
  /** Whether users can change attribute values on existing features. */
  canEditAttributes: boolean;
  /** Whether users can delete features. */
  canDelete: boolean;
  /**
   * Subset of column names the user is allowed to edit when
   * `canEditAttributes` is true. `null` means "all columns the
   * underlying schema marks editable". An empty array is a valid
   * value and means "no columns" -- equivalent to canEditAttributes
   * being false but kept distinct so the runtime can show a clearer
   * message ("you can edit features but no fields are editable").
   */
  editableFields: string[] | null;
  /**
   * Row scope for this target. `'all'` lets the user touch any row
   * the underlying share allows them to see; `'own'` restricts to
   * rows the user authored (created_by = self). The user's share on
   * the Editor item can narrow further. Cannot escalate beyond the
   * data_layer's editing policy.
   */
  rowScope: 'all' | 'own';
  /**
   * Optional feature templates for this layer. A template is a
   * preset of attribute values plus a drawing tool, used to speed
   * up repeated feature creation. When empty, "Add" is plain (empty
   * attributes, geometry tool inferred from the layer's geometry
   * type).
   */
  templates: EditorFeatureTemplate[];
}

/**
 * A feature template (a la classic ArcGIS Pro). Click the template,
 * draw, attribute panel auto-populates the preset attributes.
 */
export interface EditorFeatureTemplate {
  /** Stable id within this target. Generated client-side at create. */
  id: string;
  /** Human-readable label shown in the template tray. */
  label: string;
  /**
   * Geometry tool used when this template is active. Constrained
   * to a single geometry kind so the user always knows what shape
   * they're drawing.
   */
  geometryTool: 'point' | 'line' | 'polygon';
  /**
   * Attribute values to pre-fill when a feature is created from
   * this template. Keys are column names; values are the literal
   * values to assign. Type coercion happens at submit time using
   * the layer schema.
   */
  presetAttributes: Record<string, string | number | boolean | null>;
  /**
   * Optional preview color for the template tile. Falls back to
   * the layer's symbology when omitted.
   */
  previewColor?: string;
}

/**
 * Tools available in the editor's palette. The runtime only renders
 * tools in the active `tools` list. Adding a tool here costs nothing
 * if the runtime ignores unknown values, but every option introduces
 * UI surface so we keep the list narrow.
 */
export type EditorTool =
  | 'select'
  | 'add'
  | 'edit'
  | 'delete'
  | 'snap'
  | 'measure'
  | 'undo'
  | 'redo';

/**
 * Snap settings. Snap-to-self lets vertices snap to other vertices
 * in the same layer; the alternative is snap-to-anything-visible,
 * which can produce unwanted matches in dense maps. Tolerance is in
 * screen pixels rather than map units so behavior stays consistent
 * across zoom levels.
 */
export interface EditorSnapping {
  enabled: boolean;
  selfSnap: boolean;
  tolerancePx: number;
}

export const DEFAULT_EDITOR_SNAPPING: EditorSnapping = {
  enabled: true,
  selfSnap: true,
  tolerancePx: 10,
};

export const DEFAULT_EDITOR_TOOLS: EditorTool[] = [
  'select',
  'add',
  'edit',
  'delete',
  'snap',
  'undo',
  'redo',
];

/**
 * Freshly-created Editor with the defaults we want every new editor
 * to carry. No targets and no map reference: the user picks those
 * on the detail page after create. The runtime renders an empty-state
 * prompt until the first target is added.
 */
export const DEFAULT_EDITOR: EditorData = {
  version: 1,
  targets: [],
  tools: DEFAULT_EDITOR_TOOLS,
  snapping: DEFAULT_EDITOR_SNAPPING,
};
