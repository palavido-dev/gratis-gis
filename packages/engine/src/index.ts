// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public entry point for the engine package. Re-exports the types and
// helpers callers need; the actual write/read implementations against
// Postgres live in `apps/portal-api/src/engine/` so the database client
// stays out of this package.

export type {
  Observation,
  ObservationKind,
  PrincipalRef,
  SourceRef,
  GeoJsonGeometry,
  ReadQuery,
  ReadFeature,
} from './types.js';

export type {
  Lens,
  LensQuery,
  LensRender,
  LensRenderGeoJson,
  LensRenderGeoJsonTable,
  LensRenderMvt,
  LensRenderScalar,
  LensCacheHint,
  LensView,
  LensAttrFilter,
  BBox,
} from './lens.js';
export { isLens, bboxFromGeometry } from './lens.js';

export type {
  EsriWebMap,
  EsriOperationalLayer,
  EsriBaseMap,
  EsriInitialState,
  WebMapJsonContext,
} from './web-map-json.js';
export {
  lensToWebMapJson,
  lensesToWebMapJson,
  operationalLayerForLens,
  webMapJsonToLens,
  webMapJsonToLenses,
  toEsriTemplate,
  fromEsriTemplate,
} from './web-map-json.js';

export { uuidv7, uuidv7Timestamp, isUuid } from './uuid.js';
export { cellForGeometry, representativePoint, H3_RESOLUTION } from './cell.js';
export { validateObservation, ObservationValidationError } from './validate.js';
