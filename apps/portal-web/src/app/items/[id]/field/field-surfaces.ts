// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shapes the field runtime's overlays are made of.
 *
 * These lived INSIDE the FieldRuntime function body, which is why
 * FieldFeaturePopupSheet typed its props as `unknown` and then cast
 * back: a type declared in a function's lexical scope cannot be named
 * from outside it. The same six-field hit shape was written out five
 * separate times as a result, once per prop, and the sheet's own
 * comment admitted the cast existed only to avoid a sixth. A cast
 * that exists to work around a scoping accident is not a type
 * boundary, it is a hole in one.
 */

// `import type` only, so this cycle back to field-runtime.tsx is
// erased at compile time and creates no runtime import cycle.
import type { EditableLayer } from './field-runtime';

/** One feature the collector tapped, as the sheet renders it. */
export interface FeatureSheetHit {
  /** MapLayer id that produced this hit. */
  mapLayerId: string;
  /** Layer label rendered in the sheet header / list row. */
  layerLabel: string;
  /** global_id of the feature, if available. Needed for Edit. */
  globalId: string | null;
  /** Properties exposed to the user; underscore-prefixed system
   *  metadata is stripped before it gets here. */
  properties: Record<string, unknown>;
  /** Raw geometry as MapLibre returned it. */
  geometry: GeoJSON.Geometry | null;
  /** Editable layer when the user has edit access, else null. */
  editable: EditableLayer | null;
}

/**
 * Feature popup state. Tapping a feature opens a bottom sheet rather
 * than a MapLibre canvas popup:
 *
 *   - 'list' when the tap hit overlapping features: one row each,
 *     with layer label, swatch and title. Tapping a row drills in.
 *   - 'detail' for a single feature: title, attribute table, and the
 *     Edit / Copy / More actions.
 *
 * Expandable from the default height to near-fullscreen so a long
 * attribute list can spread out without leaving the sheet.
 */
export type FeatureSheetState =
  | null
  | { mode: 'list'; hits: FeatureSheetHit[]; expanded: boolean }
  | {
      mode: 'detail';
      hit: FeatureSheetHit;
      from: 'list' | 'direct';
      listHits: FeatureSheetHit[];
      expanded: boolean;
    };

/**
 * What the collect form is doing. 'add' starts from the template's
 * preset attributes plus a geometry stamped from the map; 'edit'
 * pre-fills from the tapped feature.
 */
export type FormModalState =
  | null
  | {
      layer: EditableLayer;
      mode: 'add';
      /**
       * The globalId this capture will be created with, generated when
       * the form OPENS rather than when it submits.
       *
       * It used to be minted inside the submit handler, which was fine
       * while nothing needed the id before then. Attachments do: a
       * photo is captured against the feature minutes before the form
       * is submitted, and it has to be filed under the id the feature
       * will actually have. Deriving it in the form component instead
       * would go stale the moment one add form is replaced by another
       * without unmounting, which is exactly what "add a related
       * record" does.
       */
      featureId: string;
      geometry: GeoJSON.Geometry | null;
      presetAttributes: Record<string, string>;
    }
  | {
      layer: EditableLayer;
      mode: 'edit';
      featureId: string;
      properties: Record<string, unknown>;
      geometry: GeoJSON.Geometry | null;
    };

/**
 * What the map tap gesture currently means.
 *
 * Three separate `map.on('click')` registrations used to be kept
 * disjoint by three hand-maintained predicates, with no value naming
 * which one owned the gesture and nothing asserting that exactly one
 * did. Deriving the mode instead makes the exclusivity a property of
 * the type rather than of three conditions agreeing by hand.
 *
 *   - 'collect-point'   a point is being collected; a tap moves it
 *   - 'collect-vertex'  a line/polygon template is armed; a tap adds
 *                       a vertex to the run in progress
 *   - 'inspect'         nothing is armed; a tap opens the feature
 *                       sheet for whatever is under the finger
 *   - 'inert'           the map ignores taps
 *
 * The open bottom sheets are deliberately NOT inputs here. A sheet
 * covers part of the map but the rest stays live, and tapping another
 * feature while the sheet is open is the behaviour we want.
 */
export type MapInteractionMode =
  | 'collect-point'
  | 'collect-vertex'
  | 'inspect'
  | 'inert';

/**
 * Which sheet owns the bottom of the viewport.
 *
 * Three surfaces compete for the same space and only one can have it:
 * the collect form, the tapped-feature popup, and the template picker.
 * That exclusivity used to be hand-written per pair, and only for the
 * pair somebody had noticed. The feature sheet carried an explicit
 * `&& formModal === null`; the picker carried nothing, so opening it
 * while a feature sheet was up stacked two sheets on the same edge.
 * Resolving it in one place makes the precedence a fact rather than a
 * set of conditions that happen to agree.
 *
 * The runtime's OTHER overlays are deliberately not in here. The
 * layer panel, the download modal, the rejected-edits dialog and the
 * search bar are not bottom sheets and genuinely do coexist: the
 * download modal is opened FROM the layer panel and has to render over
 * it. Folding all seven into one union, as the audit proposed, would
 * have invented an exclusivity the product does not have.
 */
export type BottomSheet = 'none' | 'form' | 'picker' | 'feature';
