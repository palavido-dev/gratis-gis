// SPDX-License-Identifier: AGPL-3.0-or-later
import { fieldDoc, type EsriLayerSchema } from './esri-fields.js';
import type { EsriGeometryType } from './esri-geometry.js';
import { MAX_RECORD_COUNT } from './esri-query-params.js';
import type { Extent } from './featureserver-query.service.js';

/**
 * The JSON documents an Esri client reads before it queries: the
 * server info, the service list, a service and its layers. Every
 * capability declared here is one the server really has: a client
 * that sees a flag acts on it, and a false one moves the failure from
 * the client to us.
 */

export const CURRENT_VERSION = 11.1;

export const WGS84 = { wkid: 4326, latestWkid: 4326 };

const SPATIAL_RELS = [
  'esriSpatialRelIntersects',
  'esriSpatialRelContains',
  'esriSpatialRelCrosses',
  'esriSpatialRelEnvelopeIntersects',
  'esriSpatialRelIndexIntersects',
  'esriSpatialRelOverlaps',
  'esriSpatialRelTouches',
  'esriSpatialRelWithin',
];

const BLUE = [0, 112, 255, 255];

function renderer(type: EsriGeometryType): Record<string, unknown> {
  switch (type) {
    case 'esriGeometryPoint':
    case 'esriGeometryMultipoint':
      return {
        type: 'simple',
        symbol: {
          type: 'esriSMS',
          style: 'esriSMSCircle',
          color: BLUE,
          size: 6,
          angle: 0,
          xoffset: 0,
          yoffset: 0,
          outline: { color: [255, 255, 255, 255], width: 0.75 },
        },
      };
    case 'esriGeometryPolyline':
      return { type: 'simple', symbol: { type: 'esriSLS', style: 'esriSLSSolid', color: BLUE, width: 1.5 } };
    default:
      return {
        type: 'simple',
        symbol: {
          type: 'esriSFS',
          style: 'esriSFSSolid',
          color: [0, 112, 255, 64],
          outline: { type: 'esriSLS', style: 'esriSLSSolid', color: BLUE, width: 1 },
        },
      };
  }
}

export const WORLD: Extent = { xmin: -180, ymin: -90, xmax: 180, ymax: 90 };

export function extentDoc(e: Extent | null, sr: { wkid: number; latestWkid: number } = WGS84): Record<string, unknown> {
  return { ...(e ?? WORLD), spatialReference: sr };
}

/** `/rest/info`. Signing in arrives with the edit support. */
export function infoDoc(): Record<string, unknown> {
  // No owningSystemUrl: when it is present, clients go looking for an
  // ArcGIS Enterprise portal behind this server.
  return {
    currentVersion: CURRENT_VERSION,
    fullVersion: '11.1.0',
    authInfo: { isTokenBasedSecurity: false },
  };
}

export interface ServiceLayerRef {
  index: number;
  name: string;
  geometryType: EsriGeometryType | null;
}

export function serviceDoc(args: {
  title: string;
  description: string;
  layers: ServiceLayerRef[];
  extent: Extent | null;
}): Record<string, unknown> {
  const spatial = args.layers.filter((l) => l.geometryType !== null);
  const tables = args.layers.filter((l) => l.geometryType === null);
  return {
    currentVersion: CURRENT_VERSION,
    serviceDescription: args.description,
    hasVersionedData: false,
    supportsDisconnectedEditing: false,
    hasStaticData: false,
    hasSharedDomains: false,
    maxRecordCount: MAX_RECORD_COUNT,
    supportedQueryFormats: 'JSON, geoJSON',
    supportedExportFormats: '',
    capabilities: 'Query',
    description: args.description,
    copyrightText: '',
    spatialReference: WGS84,
    initialExtent: extentDoc(args.extent),
    fullExtent: extentDoc(args.extent),
    allowGeometryUpdates: false,
    units: 'esriDecimalDegrees',
    syncEnabled: false,
    supportsApplyEditsWithGlobalIds: false,
    enableZDefaults: false,
    layers: spatial.map((l) => ({
      id: l.index,
      name: l.name,
      parentLayerId: -1,
      defaultVisibility: true,
      subLayerIds: null,
      minScale: 0,
      maxScale: 0,
      type: 'Feature Layer',
      geometryType: l.geometryType,
    })),
    tables: tables.map((l) => ({ id: l.index, name: l.name, type: 'Table' })),
    documentInfo: { Title: args.title, Author: '', Comments: '', Subject: '', Category: '', Keywords: '' },
  };
}

export function layerDoc(args: {
  index: number;
  name: string;
  description: string;
  geometryType: EsriGeometryType | null;
  schema: EsriLayerSchema;
  extent: Extent | null;
}): Record<string, unknown> {
  const { schema } = args;
  const doc: Record<string, unknown> = {
    currentVersion: CURRENT_VERSION,
    id: args.index,
    name: args.name,
    type: args.geometryType ? 'Feature Layer' : 'Table',
    description: args.description,
    copyrightText: '',
    defaultVisibility: true,
    isDataVersioned: false,
    supportsAdvancedQueries: true,
    supportsStatistics: true,
    supportsValidateSql: false,
    supportsCalculate: false,
    supportsCoordinatesQuantization: false,
    supportsDatumTransformation: false,
    useStandardizedQueries: true,
    advancedQueryCapabilities: {
      useStandardizedQueries: true,
      supportsStatistics: true,
      supportsPagination: true,
      supportsPaginationOnAggregatedQueries: false,
      supportsOrderBy: true,
      supportsDistinct: true,
      supportsCountDistinct: false,
      supportsHavingClause: false,
      supportsSqlExpression: false,
      supportsQueryWithDistance: false,
      supportsReturningQueryExtent: true,
      supportsTrueCurve: false,
      supportsQueryWithResultType: false,
      supportsReturningGeometryCentroid: false,
    },
    displayField: schema.displayField,
    typeIdField: null,
    subtypeField: null,
    fields: schema.fields.map(fieldDoc),
    indexes: [schema.oidField, schema.globalIdField].map((name) => ({
      name: `${name}_index`,
      fields: name,
      isAscending: true,
      isUnique: true,
      description: '',
      indexType: 'Attribute',
    })),
    types: [],
    templates: [],
    relationships: [],
    objectIdField: schema.oidField,
    globalIdField: schema.globalIdField,
    uniqueIdField: { name: schema.oidField, isSystemMaintained: true },
    maxRecordCount: MAX_RECORD_COUNT,
    standardMaxRecordCount: MAX_RECORD_COUNT,
    maxRecordCountFactor: 1,
    supportedQueryFormats: 'JSON, geoJSON',
    capabilities: 'Query',
    hasAttachments: false,
    htmlPopupType: 'esriServerHTMLPopupTypeNone',
    hasMetadata: false,
    hasStaticData: false,
    allowGeometryUpdates: false,
    syncEnabled: false,
    minScale: 0,
    maxScale: 0,
  };
  if (args.geometryType) {
    doc.geometryType = args.geometryType;
    doc.hasZ = false;
    doc.hasM = false;
    doc.sourceSpatialReference = WGS84;
    doc.extent = extentDoc(args.extent);
    doc.supportedSpatialRelationships = SPATIAL_RELS;
    doc.drawingInfo = { renderer: renderer(args.geometryType), transparency: 0, labelingInfo: null };
  }
  return doc;
}
