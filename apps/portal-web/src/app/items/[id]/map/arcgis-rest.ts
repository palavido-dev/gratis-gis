/**
 * Canonical impl lives at `@/lib/arcgis-rest`: moved out of the
 * bracketed route segment so callers from outside `items/[id]/...` can
 * import it without Next.js's webpack choking on the relative `[id]`.
 *
 * This file stays as a zero-cost re-export so the viewer code (which
 * lives alongside this path) keeps working without rewriting imports.
 */
export {
  probeService,
  fetchLayerBBox,
} from '@/lib/arcgis-rest';
export type {
  ArcgisServiceType,
  ArcgisServiceDescription,
  ArcgisServiceLayer,
} from '@/lib/arcgis-rest';
