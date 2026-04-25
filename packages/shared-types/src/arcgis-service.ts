/**
 * Canonical shape stored in an Item's dataJson when `type = 'arcgis_service'`.
 *
 * An arcgis_service item is a thin pointer at a remote ArcGIS REST
 * MapServer or FeatureServer: no feature data lives in the item
 * itself. The viewer queries the service live by bounding box each
 * time a map draws the layer, so the item's job is just to persist
 * the minimum metadata a map layer needs (which URL, which sublayer,
 * what service type) plus a probed-at-creation snapshot of the layer
 * list so the picker doesn't have to re-hit the service every time
 * an author opens Add Layer.
 *
 * The `defaultLayerId` field names the layer a map uses when it picks
 * this item without specifying a sublayer. Services with a single
 * sublayer can omit it; multi-layer services typically point at the
 * most useful index.
 *
 * Authentication tokens are deliberately NOT stored here. That lives
 * on the item's secrets bag (once that infra ships) so share scopes
 * apply to credentials separately from the metadata.
 */
import type { ISODateString } from './ids';

export type ArcgisServiceKind = 'MapServer' | 'FeatureServer';

export interface ArcgisServiceLayerSnapshot {
  id: number;
  name: string;
  /** ArcGIS geometry enum when the layer has geometry (omit for tables). */
  geometryType?: string;
}

/**
 * Reusable mixin for any item type that points at an external
 * multi-layer service (arcgis_service today, wms_service and
 * wfs_service later). An item carries a subset of the upstream
 * service's layers: the portal's "curated view" on it: plus
 * optional per-layer overrides the author can set without round-
 * tripping upstream (display-label rename, default-hidden flag).
 *
 * selectedLayerIds is the canonical ordered list of layers this item
 * owns. Consumers (web-map add-layer dialog, dependency scanners,
 * schema inspectors) should respect this list rather than the raw
 * probed `layers` array.
 *
 * Items created before this shape landed have neither field; callers
 * should treat "no selectedLayerIds" as "all probed layers selected"
 * for backward compatibility.
 */
export interface ExternalLayerSelection {
  /** Ordered IDs of layers the item curates. */
  selectedLayerIds?: Array<string | number>;
  /** Which of the selected layers is the default when an app or map
   *  consumes this item without a more specific picker. */
  defaultLayerId?: string | number;
  /** Optional per-layer UI overrides. Keys are layer IDs (coerced
   *  to string to stay JSON-safe). */
  layerConfig?: Record<
    string,
    {
      /** Override the upstream display name. */
      label?: string;
      /** Start hidden in the default map rendering: the author
       *  keeps the layer in the curated set but doesn't draw it by
       *  default. User can toggle on. */
      visible?: boolean;
    }
  >;
}

export interface ArcgisServiceData extends ExternalLayerSelection {
  version: 1;
  /** Root service URL, without a trailing /<layerId> segment. */
  url: string;
  serviceType: ArcgisServiceKind;
  /**
   * Inherited from ExternalLayerSelection as string | number; for
   * arcgis_service items it is always a number at runtime. Consumers
   * that need the concrete number type should cast + round-trip
   * through Number() since JSON-sourced values can arrive as strings
   * when an older migration wrote them as such.
   */
  /** Probed at item-create time so the picker doesn't refetch. */
  layers: ArcgisServiceLayerSnapshot[];
  /**
   * Service-level full extent when the server reported it in WGS84.
   * Used to "Zoom to item" on the detail page without a round-trip.
   */
  bbox?: [number, number, number, number];
  probedAt?: ISODateString;
}

export const DEFAULT_ARCGIS_SERVICE: ArcgisServiceData = {
  version: 1,
  url: '',
  serviceType: 'MapServer',
  layers: [],
};

/**
 * Resolve the effective selected-layer list for an arcgis_service
 * item. Pre-multi-layer items don't carry `selectedLayerIds`, in
 * which case we fall back to "every probed layer is selected" so
 * legacy items keep working unchanged.
 */
export function effectiveArcgisLayers(
  data: Pick<ArcgisServiceData, 'layers' | 'selectedLayerIds'>,
): ArcgisServiceLayerSnapshot[] {
  if (!data.selectedLayerIds) return data.layers;
  const pick = new Set(data.selectedLayerIds.map((i) => String(i)));
  return data.layers.filter((l) => pick.has(String(l.id)));
}
