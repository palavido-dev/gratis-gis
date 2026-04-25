/**
 * Canonical shape stored in an Item's dataJson when
 * `type = 'wms_service'` or `type = 'wfs_service'`.
 *
 * Like arcgis_service, these items are thin pointers at a remote
 * service (no feature data is ingested into the portal). Renderers
 * compose tile URLs / GetFeature requests at draw time. The probed
 * `layers` snapshot is what the picker shows; `selectedLayerIds`
 * (inherited from ExternalLayerSelection) records which of those
 * the item curates.
 *
 * The `version` field on each interface is a Prisma-friendly schema
 * version, NOT the WMS / WFS protocol version (those go in
 * `protocolVersion`).
 */
import type { ISODateString } from './ids';
import type { ExternalLayerSelection } from './arcgis-service';

export interface WmsLayerSnapshot {
  /** WMS layer name (`<Layer><Name>`). The id MapLibre uses too. */
  name: string;
  /** Optional human label for the picker; falls back to `name`. */
  title?: string;
  /** Optional WMS style name. WMS allows multiple styles per layer;
   *  blank means "use the server default". */
  style?: string;
  bbox?: [number, number, number, number];
}

export interface WfsLayerSnapshot {
  /** WFS feature type name (typeName, may include namespace prefix). */
  name: string;
  title?: string;
  bbox?: [number, number, number, number];
}

export interface WmsServiceData extends ExternalLayerSelection {
  version: 1;
  /** GetCapabilities base URL (without query string). */
  url: string;
  /** Protocol version: 1.1.1 or 1.3.0 in the wild. */
  protocolVersion: '1.1.1' | '1.3.0';
  /** Output format the renderer should ask for. PNG is the safe
   *  default; some servers serve only image/jpeg. */
  format?: string;
  /** Whether to request transparent tiles. Most consumers want true. */
  transparent?: boolean;
  /** Coordinate reference system to request. EPSG:3857 is standard
   *  for slippy-map basemaps; data overlays often need EPSG:4326. */
  crs?: string;
  layers: WmsLayerSnapshot[];
  bbox?: [number, number, number, number];
  probedAt?: ISODateString;
}

export interface WfsServiceData extends ExternalLayerSelection {
  version: 1;
  /** GetCapabilities base URL (without query string). */
  url: string;
  /** Protocol version: 2.0.0 is the current standard; 1.1.0 still
   *  shows up on older servers. */
  protocolVersion: '1.1.0' | '2.0.0';
  /** Output format for GetFeature. application/json (GeoJSON) is the
   *  modern default; GML2 / GML3 are fallbacks for older servers. */
  outputFormat?: string;
  layers: WfsLayerSnapshot[];
  bbox?: [number, number, number, number];
  probedAt?: ISODateString;
}

export const DEFAULT_WMS_SERVICE: WmsServiceData = {
  version: 1,
  url: '',
  protocolVersion: '1.3.0',
  format: 'image/png',
  transparent: true,
  crs: 'EPSG:3857',
  layers: [],
};

export const DEFAULT_WFS_SERVICE: WfsServiceData = {
  version: 1,
  url: '',
  protocolVersion: '2.0.0',
  outputFormat: 'application/json',
  layers: [],
};
