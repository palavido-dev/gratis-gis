// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hosted Feature Service importer (#43 phases 2-5).
 *
 * AGO hosted Feature Services are AGO-owned datasets: features
 * live in AGO's database, not on a third-party ArcGIS Server. The
 * point of migrating to GratisGIS is to untether from AGO, so for
 * hosted services we don't just create a pointer-back-to-AGO
 * `service` item -- we walk the service's REST surface, copy the
 * schema into a portal `data_layer` item, and stream every
 * feature into PostGIS via the observation-log engine.
 *
 * Phases this file owns:
 *   2. Service probe + per-sublayer schema fetch + data_layer
 *      creation
 *   3. Paginated feature query + bulk insert
 *   4. Reprojection handling (request outSR=4326 from AGO so we
 *      get GeoJSON in WGS84 regardless of upstream SR)
 *   5. Attachment copy via MinIO (paged fetch per feature)
 *
 * Spatial reference: the AGO REST `query` endpoint accepts an
 * `outSR=4326` parameter that asks AGO to reproject before
 * returning GeoJSON. We always pass it so we never have to touch
 * proj4 ourselves; GratisGIS's engine stores in 4326.
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  DataLayerDataV3,
  DataLayerSublayer,
  FeatureField,
  FeatureFieldType,
  LayerGeometryType,
} from '@gratis-gis/shared-types';
import { DEFAULT_DATA_LAYER_V3 } from '@gratis-gis/shared-types';
import type { Prisma } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { assertSafeOutboundUrl, safeFetch } from '../common/net-guards.js';
import { ItemsService } from '../items/items.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { FEATURE_ATTACHMENT_MAX_BYTES, StorageService } from '../storage/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ----------------------------------------------------------------
// AGO REST response shapes (narrow, only what we consume)
// ----------------------------------------------------------------

/** Top-level service description from `<serviceUrl>?f=json`. */
interface AgoServiceDescribe {
  serviceDescription?: string;
  layers?: Array<{
    id: number;
    name?: string;
    type?: string;
    geometryType?: string;
    description?: string;
  }>;
  tables?: Array<{
    id: number;
    name?: string;
    type?: string;
  }>;
  spatialReference?: { wkid?: number; latestWkid?: number };
  capabilities?: string;
}

/** Per-layer description from `<serviceUrl>/<layerId>?f=json`. */
interface AgoLayerDescribe {
  id: number;
  name?: string;
  type?: string;
  geometryType?: string;
  description?: string;
  hasAttachments?: boolean;
  /** Each field is { name, type, alias, length, nullable, domain? }. */
  fields?: Array<{
    name: string;
    type: string;
    alias?: string;
    length?: number;
    nullable?: boolean;
    domain?: {
      type?: string;
      codedValues?: Array<{ name: string; code: string | number }>;
      range?: [number, number];
    } | null;
  }>;
  spatialReference?: { wkid?: number; latestWkid?: number };
  objectIdField?: string;
  globalIdField?: string;
}

/** Paginated `query` response when `f=geojson`. */
interface AgoGeoJsonResponse {
  type?: 'FeatureCollection';
  features?: Array<{
    type: 'Feature';
    id?: number | string;
    geometry: unknown;
    properties: Record<string, unknown>;
  }>;
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
}

interface AgoAttachmentInfoResponse {
  attachmentInfos?: Array<{
    id: number;
    contentType: string;
    name: string;
    size: number;
  }>;
}

// ----------------------------------------------------------------
// Public result shape
// ----------------------------------------------------------------

export interface HostedFsImportResult {
  portalItemId: string;
  layerCount: number;
  featuresInserted: number;
  attachmentsCopied: number;
  warnings: string[];
  /**
   * Map from AGO REST layer id (the integer in `<serviceUrl>/<id>`)
   * to the portal data_layer sublayer key. The Web Map importer
   * needs this to translate a WebMap operationalLayer URL like
   * `https://services1.arcgis.com/.../FeatureServer/0` into a
   * portal `{ kind: 'data-layer', itemId, layerKey }` source.
   * Without this, the WebMap converter falls back to the
   * external-arcgis-rest path and the imported map keeps pointing
   * at AGO. Key is the AGO layer id (number); value is the
   * sublayer.id we just stored on the portal item (a sanitized
   * version of the AGO layer name).
   */
  agoLayerIdToSublayerKey: Record<number, string>;
  /** True when pagination stopped because the feature hard cap was hit. */
  truncated?: boolean;
}

/** Most bytes read from one AGO JSON reply (a page of up to 2000
 *  features is the largest). safeFetch's own default is 1 GiB. */
const AGO_JSON_MAX_BYTES = 256 * 1024 * 1024;
/** How long one AGO call may take, body included. Without it a
 *  server that answers and then stalls holds the import forever. */
const AGO_FETCH_TIMEOUT_MS = 120_000;

/** Default hard cap for interactive "Copy to data layer" jobs.
 *  Matches the OSM save-as-layer ceiling; admin AGO import stays uncapped. */
export const ARCGIS_COPY_FEATURE_HARD_CAP = 50_000;

// ----------------------------------------------------------------
// Service
// ----------------------------------------------------------------

@Injectable()
export class AgoHostedFsImportService {
  private readonly log = new Logger(AgoHostedFsImportService.name);

  /** AGO `query` page size. 2000 is the documented default cap on
   *  hosted services; larger requests fall back to the server's
   *  `maxRecordCount`. We chunk smaller than that here so a single
   *  page fits well under HTTP body limits even on rich attribute
   *  schemas. */
  private readonly PAGE_SIZE = 2000;

  /** Insert batch size into the engine. 500 keeps each transaction
   *  short enough to stay well under the 60s statement_timeout the
   *  portal sets, even on big polygon geometries. */
  private readonly INSERT_BATCH = 500;

  constructor(
    private readonly items: ItemsService,
    private readonly features: DataLayerFeaturesService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Import one hosted Feature Service end-to-end.
   *
   * Steps:
   *   1. Probe the service to enumerate layers.
   *   2. Per layer, fetch the schema. Build sublayers.
   *   3. Create the portal data_layer item.
   *   4. Per layer, page through features (outSR=4326) and
   *      bulk-insert.
   *   5. If `copyAttachments`, fetch attachmentInfos per feature
   *      and stream each attachment binary into MinIO with a
   *      feature_attachment row.
   *
   * Returns counts + the new item id so the caller can build the
   * `agoServiceUrl -> portalDataLayerItemId` map the Web Map
   * remapper (phase 6) consumes.
   */
  async run(args: {
    user: AuthUser;
    serviceUrl: string;
    /** Source AGO item id (for provenance + ImportReport). */
    agoItemId: string;
    /** Item title to seed the new data_layer with. */
    title: string;
    /** AGO sharing scope mirrored onto the new item. */
    access: 'private' | 'org' | 'public';
    /** AGO bearer token; appended as ?token=... on every fetch.
     *  Anonymous services pass undefined. */
    token?: string;
    /** Whether to fetch + re-host feature attachments. v1 always on
     *  unless the operator declined; can be defaulted off for the
     *  fast path. */
    copyAttachments?: boolean;
  }): Promise<HostedFsImportResult> {
    const warnings: string[] = [];
    const cleanUrl = args.serviceUrl.replace(/(?<!\/)\/+$/, '');

    // The service URL comes off the user-supplied dry-run report
    // and seeds every per-layer / per-feature / per-attachment URL
    // this importer builds. Validate it once up front so a hostile
    // URL fails loudly here instead of surfacing as hundreds of
    // swallowed per-row errors deeper in the walk (each fetch below
    // still goes through safeFetch as defense in depth).
    await assertSafeOutboundUrl(`${cleanUrl}?f=json`);

    // 1. probe service
    const desc = await this.fetchJson<AgoServiceDescribe>(
      `${cleanUrl}?f=json`,
      args.token,
    );
    const layerStubs = [
      ...(desc.layers ?? []),
      ...(desc.tables ?? []).map((t) => ({ ...t, geometryType: undefined })),
    ];
    if (layerStubs.length === 0) {
      throw new Error(
        `Hosted Feature Service ${cleanUrl} has no layers; nothing to import.`,
      );
    }

    // 2. per-layer schema
    const sublayers: DataLayerSublayer[] = [];
    const perLayer: Array<{
      stubId: number;
      sublayer: DataLayerSublayer;
      hasAttachments: boolean;
      objectIdField: string;
    }> = [];
    for (const stub of layerStubs) {
      const layer = await this.fetchJson<AgoLayerDescribe>(
        `${cleanUrl}/${stub.id}?f=json`,
        args.token,
      );
      const sublayer = uniqueSublayerId(this.layerToSublayer(layer, warnings), sublayers, stub.id);
      sublayers.push(sublayer);
      perLayer.push({
        stubId: stub.id,
        sublayer,
        hasAttachments: Boolean(layer.hasAttachments),
        objectIdField:
          layer.objectIdField ?? layer.globalIdField ?? 'OBJECTID',
      });
    }

    // 3. create the data_layer item with all sublayers
    const data: DataLayerDataV3 = {
      ...DEFAULT_DATA_LAYER_V3,
      layers: sublayers,
    };
    const created = await this.items.create(args.user, {
      type: 'data_layer',
      title: args.title,
      access: args.access,
      data: data as unknown as Prisma.InputJsonValue,
    });

    // 4. paginated feature copy
    const idMaps = new Map<number, Map<string, string>>();
    let featuresInserted = 0;
    for (const layer of perLayer) {
      try {
        const inserted = await this.copyLayerFeatures({
          user: args.user,
          itemId: created.id,
          serviceUrl: cleanUrl,
          layer,
          ...(args.token !== undefined ? { token: args.token } : {}),
          ...idMapFor(idMaps, layer, args.copyAttachments),
        });
        featuresInserted += inserted;
      } catch (e) {
        warnings.push(
          `Layer ${layer.sublayer.label}: feature copy failed (${
            e instanceof Error ? e.message : String(e)
          }). Schema is in place; data can be re-pulled later.`,
        );
      }
    }

    // 5. attachments (per feature, per layer)
    let attachmentsCopied = 0;
    if (args.copyAttachments) {
      for (const layer of perLayer) {
        if (!layer.hasAttachments) continue;
        try {
          attachmentsCopied += await this.copyLayerAttachments({
            user: args.user,
            itemId: created.id,
            serviceUrl: cleanUrl,
            layer,
            ...(args.token !== undefined ? { token: args.token } : {}),
            idMap: idMaps.get(layer.stubId) ?? new Map(),
          });
        } catch (e) {
          warnings.push(
            `Layer ${layer.sublayer.label}: attachment copy failed (${
              e instanceof Error ? e.message : String(e)
            }). Geometry + attributes already landed.`,
          );
        }
      }
    }

    // Build the AGO-layer-id -> portal-sublayer-key mapping so the
    // Web Map importer can translate `<serviceUrl>/<n>` references
    // straight into a portal data-layer source. Without this, the
    // imported map stays pointed at AGO.
    const agoLayerIdToSublayerKey: Record<number, string> = {};
    for (const pl of perLayer) {
      agoLayerIdToSublayerKey[pl.stubId] = pl.sublayer.id;
    }

    return {
      portalItemId: created.id,
      layerCount: sublayers.length,
      featuresInserted,
      attachmentsCopied,
      warnings,
      agoLayerIdToSublayerKey,
    };
  }

  /**
   * Interactive / item-scoped copy used by arcgis_service
   * "Copy selected layers to data layer". Same FeatureServer walk as
   * {@link run}, but:
   *   - only the requested REST layer ids
   *   - no agoItemId provenance requirement
   *   - hard feature cap (default {@link ARCGIS_COPY_FEATURE_HARD_CAP})
   *   - attachments off by default
   */
  async runSelected(args: {
    user: AuthUser;
    serviceUrl: string;
    title: string;
    access: 'private' | 'org' | 'public';
    token?: string;
    layerIds: number[];
    maxFeatures?: number;
    copyAttachments?: boolean;
  }): Promise<HostedFsImportResult> {
    const warnings: string[] = [];
    const cleanUrl = args.serviceUrl.replace(/(?<!\/)\/+$/, '');
    const maxFeatures = Math.min(
      Math.max(1, args.maxFeatures ?? ARCGIS_COPY_FEATURE_HARD_CAP),
      ARCGIS_COPY_FEATURE_HARD_CAP,
    );
    const wanted = new Set(args.layerIds);
    if (wanted.size === 0) {
      throw new Error('Select at least one layer to copy.');
    }

    await assertSafeOutboundUrl(`${cleanUrl}?f=json`);

    const desc = await this.fetchJson<AgoServiceDescribe>(
      `${cleanUrl}?f=json`,
      args.token,
    );
    const layerStubs = [
      ...(desc.layers ?? []),
      ...(desc.tables ?? []).map((t) => ({ ...t, geometryType: undefined })),
    ].filter((s) => wanted.has(s.id));
    if (layerStubs.length === 0) {
      throw new Error(
        `None of the selected layer ids exist on ${cleanUrl}.`,
      );
    }
    const missing = [...wanted].filter(
      (id) => !layerStubs.some((s) => s.id === id),
    );
    for (const id of missing) {
      warnings.push(`Layer id ${id} was not found on the service and was skipped.`);
    }

    const sublayers: DataLayerSublayer[] = [];
    const perLayer: Array<{
      stubId: number;
      sublayer: DataLayerSublayer;
      hasAttachments: boolean;
      objectIdField: string;
    }> = [];
    for (const stub of layerStubs) {
      const layer = await this.fetchJson<AgoLayerDescribe>(
        `${cleanUrl}/${stub.id}?f=json`,
        args.token,
      );
      const sublayer = uniqueSublayerId(this.layerToSublayer(layer, warnings), sublayers, stub.id);
      sublayers.push(sublayer);
      perLayer.push({
        stubId: stub.id,
        sublayer,
        hasAttachments: Boolean(layer.hasAttachments),
        objectIdField:
          layer.objectIdField ?? layer.globalIdField ?? 'OBJECTID',
      });
    }

    const data: DataLayerDataV3 = {
      ...DEFAULT_DATA_LAYER_V3,
      layers: sublayers,
    };
    const created = await this.items.create(args.user, {
      type: 'data_layer',
      title: args.title,
      access: args.access,
      data: data as unknown as Prisma.InputJsonValue,
    });

    const idMaps = new Map<number, Map<string, string>>();
    let featuresInserted = 0;
    let truncated = false;
    let remaining = maxFeatures;
    for (const layer of perLayer) {
      if (remaining <= 0) {
        truncated = true;
        warnings.push(
          `Stopped before layer ${layer.sublayer.label}: feature cap of ${maxFeatures} reached.`,
        );
        break;
      }
      try {
        const inserted = await this.copyLayerFeatures({
          user: args.user,
          itemId: created.id,
          serviceUrl: cleanUrl,
          layer,
          maxFeatures: remaining,
          ...(args.token !== undefined ? { token: args.token } : {}),
          ...idMapFor(idMaps, layer, args.copyAttachments),
        });
        featuresInserted += inserted;
        remaining -= inserted;
        if (remaining <= 0) {
          truncated = true;
          warnings.push(
            `Reached the feature cap of ${maxFeatures}. Remaining layers were not copied; use Admin → Migrations for a full import, or copy fewer layers.`,
          );
        }
      } catch (e) {
        warnings.push(
          `Layer ${layer.sublayer.label}: feature copy failed (${
            e instanceof Error ? e.message : String(e)
          }). Schema is in place; data can be re-pulled later.`,
        );
      }
    }

    let attachmentsCopied = 0;
    if (args.copyAttachments && !truncated) {
      for (const layer of perLayer) {
        if (!layer.hasAttachments) continue;
        try {
          attachmentsCopied += await this.copyLayerAttachments({
            user: args.user,
            itemId: created.id,
            serviceUrl: cleanUrl,
            layer,
            ...(args.token !== undefined ? { token: args.token } : {}),
            idMap: idMaps.get(layer.stubId) ?? new Map(),
          });
        } catch (e) {
          warnings.push(
            `Layer ${layer.sublayer.label}: attachment copy failed (${
              e instanceof Error ? e.message : String(e)
            }). Geometry + attributes already landed.`,
          );
        }
      }
    }

    const agoLayerIdToSublayerKey: Record<number, string> = {};
    for (const pl of perLayer) {
      agoLayerIdToSublayerKey[pl.stubId] = pl.sublayer.id;
    }

    return {
      portalItemId: created.id,
      layerCount: sublayers.length,
      featuresInserted,
      attachmentsCopied,
      warnings,
      agoLayerIdToSublayerKey,
      truncated,
    };
  }

  // ---- private helpers --------------------------------------------------

  /** Translate one AGO layer description into a DataLayerSublayer. */
  private layerToSublayer(
    layer: AgoLayerDescribe,
    warnings: string[],
  ): DataLayerSublayer {
    const geometryType = agoGeometryToPortal(layer.geometryType);
    if (layer.geometryType && !geometryType && layer.type !== 'Table') {
      warnings.push(
        `Layer ${layer.name ?? layer.id}: unsupported geometry "${layer.geometryType}", imported as attribute-only table.`,
      );
    }
    const skipField = new Set<string>(
      [
        layer.objectIdField,
        layer.globalIdField,
        // System fields AGO usually exposes; we don't carry them.
        'OBJECTID',
        'GlobalID',
        'Shape',
        'Shape__Area',
        'Shape__Length',
        'CreationDate',
        'EditDate',
        'Creator',
        'Editor',
      ].filter((f): f is string => typeof f === 'string'),
    );
    const fields: FeatureField[] = [];
    for (const f of layer.fields ?? []) {
      if (skipField.has(f.name)) continue;
      if (f.type === 'esriFieldTypeGeometry' || f.type === 'esriFieldTypeOID') {
        continue;
      }
      fields.push({
        name: f.name,
        label: f.alias?.trim() || f.name,
        type: agoFieldTypeToPortal(f.type),
        nullable: f.nullable !== false,
        ...(f.length !== undefined
          ? { storage: { maxLength: f.length } }
          : {}),
        ...(f.domain && f.domain.type === 'codedValue' && f.domain.codedValues
          ? {
              domain: {
                type: 'coded-value' as const,
                values: f.domain.codedValues.map((v) => ({
                  code: v.code,
                  label: v.name,
                })),
              },
            }
          : {}),
      });
    }
    return {
      id: sanitizeSublayerId(layer.name ?? `layer_${layer.id}`),
      label: layer.name ?? `Layer ${layer.id}`,
      name: sanitizeSublayerId(layer.name ?? `layer_${layer.id}`),
      geometryType,
      fields,
      editingEnabled: false,
      attachmentsEnabled: Boolean(layer.hasAttachments),
    };
  }

  /** Page through one layer's features and bulk-insert into the
   *  matching portal sublayer. */
  private async copyLayerFeatures(args: {
    user: AuthUser;
    itemId: string;
    serviceUrl: string;
    layer: {
      stubId: number;
      sublayer: DataLayerSublayer;
      objectIdField: string;
    };
    token?: string;
    /** Stop after this many features (interactive copy hard cap). */
    maxFeatures?: number;
    /** When given, filled with AGO object id -> portal feature id, so
     *  attachments can be linked to the rows they belong to. */
    idMap?: Map<string, string>;
  }): Promise<number> {
    let offset = 0;
    let total = 0;
    const budget = args.maxFeatures;
    // ArcGIS sends date values as numbers, milliseconds since the
    // epoch in UTC. The portal's date fields only take ISO text (an
    // epoch is refused on purpose), so every batch holding a date was
    // rejected and the layer stopped part way.
    const dateFields = new Set(
      (args.layer.sublayer.fields ?? []).filter((f) => f.type === 'date').map((f) => f.name),
    );
    while (true) {
      if (budget !== undefined && total >= budget) break;
      const pageSize =
        budget !== undefined
          ? Math.min(this.PAGE_SIZE, budget - total)
          : this.PAGE_SIZE;
      if (pageSize <= 0) break;

      const url = new URL(
        `${args.serviceUrl}/${args.layer.stubId}/query`,
      );
      url.searchParams.set('where', '1=1');
      url.searchParams.set('outFields', '*');
      url.searchParams.set('f', 'geojson');
      url.searchParams.set('outSR', '4326');
      url.searchParams.set('resultOffset', String(offset));
      url.searchParams.set('resultRecordCount', String(pageSize));
      url.searchParams.set('orderByFields', args.layer.objectIdField);
      if (args.token) url.searchParams.set('token', args.token);

      const page = await this.fetchJson<AgoGeoJsonResponse>(
        url.toString(),
        undefined, // token already in querystring
      );
      let rows = page.features ?? [];
      if (rows.length === 0) break;
      if (budget !== undefined && total + rows.length > budget) {
        rows = rows.slice(0, budget - total);
      }

      // Insert in batches via the v3 features service.
      for (let i = 0; i < rows.length; i += this.INSERT_BATCH) {
        const batch = rows.slice(i, i + this.INSERT_BATCH);
        const result = await this.features.insertFeatures(
          args.itemId,
          args.layer.sublayer.id,
          batch.map((r) => ({
            geometry: r.geometry ?? null,
            properties: this.normalizeProps(r.properties, dateFields),
          })),
          args.user,
        );
        if (args.idMap) {
          batch.forEach((r, j) => {
            const oid = r.properties?.[args.layer.objectIdField] ?? r.id;
            const globalId = result.globalIds[j];
            if (oid !== undefined && oid !== null && globalId) {
              args.idMap!.set(String(oid), globalId);
            }
          });
        }
        total += batch.length;
      }

      if (budget !== undefined && total >= budget) break;

      // exceededTransferLimit is the canonical "more pages" signal.
      const more =
        page.exceededTransferLimit ||
        page.properties?.exceededTransferLimit ||
        (page.features?.length ?? 0) === pageSize;
      if (!more) break;
      offset += page.features?.length ?? rows.length;
    }
    return total;
  }

  /** Copy feature attachments for one layer. Walks each feature's
   *  attachmentInfos, downloads the bytes, streams to MinIO via
   *  the storage service, and writes feature_attachment rows.
   *
   *  Today this lookups feature IDs by re-querying the layer with
   *  returnIdsOnly=true so it doesn't have to hold all features in
   *  memory. For an MVP we just walk the OBJECTID list and fetch
   *  attachments per row. */
  private async copyLayerAttachments(args: {
    user: AuthUser;
    itemId: string;
    serviceUrl: string;
    layer: {
      stubId: number;
      sublayer: DataLayerSublayer;
      objectIdField: string;
    };
    token?: string;
    /** AGO object id -> portal feature id, from copyLayerFeatures. */
    idMap: ReadonlyMap<string, string>;
  }): Promise<number> {
    // Fetch all OBJECTIDs.
    const idsUrl = new URL(
      `${args.serviceUrl}/${args.layer.stubId}/query`,
    );
    idsUrl.searchParams.set('where', '1=1');
    idsUrl.searchParams.set('returnIdsOnly', 'true');
    idsUrl.searchParams.set('f', 'json');
    if (args.token) idsUrl.searchParams.set('token', args.token);
    const idsResp = await this.fetchJson<{ objectIds?: number[] }>(
      idsUrl.toString(),
    );
    const objectIds = idsResp.objectIds ?? [];
    if (objectIds.length === 0) return 0;

    let copied = 0;
    for (const oid of objectIds) {
      // The portal feature this AGO row became, recorded while the
      // features were copied. The old lookup queried observation
      // columns that do not exist, so no attachment was ever copied.
      const featureEntityId = args.idMap.get(String(oid));
      if (!featureEntityId) continue;
      const infoUrl = new URL(
        `${args.serviceUrl}/${args.layer.stubId}/${oid}/attachments`,
      );
      infoUrl.searchParams.set('f', 'json');
      if (args.token) infoUrl.searchParams.set('token', args.token);
      const info = await this.fetchJson<AgoAttachmentInfoResponse>(
        infoUrl.toString(),
      );
      const attachments = info.attachmentInfos ?? [];
      if (attachments.length === 0) continue;

      for (const att of attachments) {
        const attUrl = new URL(
          `${args.serviceUrl}/${args.layer.stubId}/${oid}/attachments/${att.id}`,
        );
        if (args.token) attUrl.searchParams.set('token', args.token);
        try {
          // safeFetch: attachment URLs derive from the report's
          // service URL, same trust level as everything else here.
          // Capped at the portal's own attachment limit and timed, so
          // one huge or stalled attachment cannot pin the heap or the
          // job.
          const res = await safeFetch(
            attUrl.toString(),
            { signal: AbortSignal.timeout(AGO_FETCH_TIMEOUT_MS) },
            { maxBytes: FEATURE_ATTACHMENT_MAX_BYTES },
          );
          if (!res.ok || !res.body) {
            await res.body?.cancel().catch(() => undefined);
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const upload = await this.storage.uploadBuffer(
            'feature-attachment',
            buf,
            att.contentType,
          );

          await this.prisma.featureAttachment.create({
            data: {
              itemId: args.itemId,
              layerId: args.layer.sublayer.id,
              featureId: featureEntityId,
              fileName: att.name,
              mime: att.contentType,
              sizeBytes: buf.length,
              storageKey: upload.key,
              storageUrl: upload.publicUrl,
              createdBy: args.user.id,
            },
          });
          copied += 1;
        } catch {
          /* per-attachment failure shouldn't break the batch */
        }
      }
    }
    return copied;
  }

  /** Strip AGO's system fields from a properties bag so we don't
   *  carry OBJECTID, GlobalID, Shape__* through into the portal
   *  observations. */
  private normalizeProps(
    props: Record<string, unknown>,
    dateFields: ReadonlySet<string> = new Set(),
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props ?? {})) {
      if (
        k === 'OBJECTID' ||
        k === 'GlobalID' ||
        k === 'Shape__Area' ||
        k === 'Shape__Length' ||
        k === 'Shape'
      ) {
        // Keep OBJECTID actually -- attachments need it for the
        // mapping back to AGO. Stuff it under a __agoObjectId key
        // so it doesn't collide with anything the user defined.
        if (k === 'OBJECTID') out.__agoObjectId = v;
        continue;
      }
      if (dateFields.has(k) && typeof v === 'number' && Number.isFinite(v)) {
        const d = new Date(v);
        out[k] = Number.isNaN(d.getTime()) ? null : d.toISOString();
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  /** Wrapped fetch that throws a readable error on non-2xx and
   *  surfaces AGO's `error: { code, message }` envelope as a real
   *  exception instead of letting it slip through as a "success"
   *  with no data. */
  private async fetchJson<T>(
    url: string,
    token?: string,
  ): Promise<T> {
    const fetchUrl = token
      ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      : url;
    // safeFetch, not fetch: every URL funneled through here derives
    // from the user-supplied dry-run report (ago-client.ts routes
    // its own traffic through the same guard).
    let res: Response;
    try {
      res = await safeFetch(
        fetchUrl,
        { signal: AbortSignal.timeout(AGO_FETCH_TIMEOUT_MS) },
        { maxBytes: AGO_JSON_MAX_BYTES },
      );
    } catch (err) {
      // Some safeFetch errors quote the URL (too many redirects, bad
      // URL), token included.
      throw new Error(redactToken(err instanceof Error ? err.message : String(err)));
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      // Name the URL without its query: callers put `token=` there,
      // and this message ends up in import warnings and the stored
      // job report.
      throw new Error(
        `AGO request failed (HTTP ${res.status}) for ${withoutQuery(url)}`,
      );
    }
    const body = (await res.json()) as T & {
      error?: { code?: number; message?: string };
    };
    if (body && typeof body === 'object' && body.error) {
      throw new Error(
        `AGO returned error ${body.error.code}: ${body.error.message}`,
      );
    }
    return body;
  }
}

// ----------------------------------------------------------------
// Mapping helpers
// ----------------------------------------------------------------

function agoGeometryToPortal(g?: string): LayerGeometryType {
  switch (g) {
    case 'esriGeometryPoint':
    case 'esriGeometryMultipoint':
      return 'point';
    case 'esriGeometryPolyline':
      return 'line';
    case 'esriGeometryPolygon':
    case 'esriGeometryEnvelope':
      return 'polygon';
    default:
      return null;
  }
}

function agoFieldTypeToPortal(t: string): FeatureFieldType {
  switch (t) {
    case 'esriFieldTypeSmallInteger':
    case 'esriFieldTypeInteger':
    case 'esriFieldTypeBigInteger':
    case 'esriFieldTypeSingle':
    case 'esriFieldTypeDouble':
      return 'number';
    case 'esriFieldTypeDate':
    case 'esriFieldTypeTimestampOffset':
      return 'date';
    case 'esriFieldTypeBoolean':
      return 'boolean';
    case 'esriFieldTypeString':
    case 'esriFieldTypeGUID':
    case 'esriFieldTypeGlobalID':
    case 'esriFieldTypeXML':
    default:
      return 'string';
  }
}

/** The id map for a layer whose attachments will be copied, or
 *  nothing, so a large layer without attachments keeps no map. */
function idMapFor(
  maps: Map<number, Map<string, string>>,
  layer: { stubId: number; hasAttachments: boolean },
  copyAttachments: boolean | undefined,
): { idMap?: Map<string, string> } {
  if (!copyAttachments || !layer.hasAttachments) return {};
  const map = new Map<string, string>();
  maps.set(layer.stubId, map);
  return { idMap: map };
}

/** Hide the value of any `token=` query parameter in a message. */
export function redactToken(message: string): string {
  return message.replace(/([?&]token=)[^&\s#]*/gi, '$1[redacted]');
}

function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? '';
  }
}

/**
 * Two AGO layers can sanitize to the same id (names in a non-Latin
 * script all become `layer`; `Parcels (2020)` and `Parcels 2020` match).
 * Both then wrote into one portal sublayer. Add the AGO layer id on a
 * clash so each keeps its own.
 */
function uniqueSublayerId(
  sublayer: DataLayerSublayer,
  taken: readonly DataLayerSublayer[],
  agoLayerId: number,
): DataLayerSublayer {
  const used = new Set(taken.map((l) => l.id));
  if (!used.has(sublayer.id)) return sublayer;
  let id = `${sublayer.id.slice(0, 50)}_${agoLayerId}`;
  for (let n = 2; used.has(id); n++) id = `${sublayer.id.slice(0, 50)}_${agoLayerId}_${n}`;
  return { ...sublayer, id, name: id };
}

function sanitizeSublayerId(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|(?<!_)_+$/g, '')
    .slice(0, 60);
  return clean.length > 0 ? clean : 'layer';
}
